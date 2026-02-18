import { google } from 'googleapis';
import { getErrorMessage } from '../../utils/errorUtils';
import { db } from '../../db';
import { announcements } from '../../../shared/schema';
import { systemSettings } from '../../../shared/models/system';
import { eq, desc, sql } from 'drizzle-orm';
import { formatDatePacific, createPacificDate } from '../../utils/dateUtils';

interface ConnectionSettings {
  settings: {
    expires_at?: string;
    access_token?: string;
    oauth?: { credentials?: { access_token?: string } };
  };
}

let connectionSettings: ConnectionSettings | undefined;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-sheet',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Google Sheet not connected');
  }
  return accessToken;
}

async function getGoogleSheetClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

async function getGoogleDriveClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

const HEADER_ROW = ['App ID', 'Title', 'Description', 'Start Date', 'End Date', 'Link Type', 'Link Target', 'Banner (yes/no)', 'Active (yes/no)', 'Status'];

function announcementToRow(a: Record<string, unknown>): string[] {
  return [
    String(a.id),
    (a.title as string) || '',
    (a.message as string) || '',
    a.starts_at || a.startsAt ? formatDatePacific(new Date((a.starts_at || a.startsAt) as string)) : '',
    a.ends_at || a.endsAt ? formatDatePacific(new Date((a.ends_at || a.endsAt) as string)) : '',
    (a.link_type || a.linkType || '') as string,
    (a.link_target || a.linkTarget || '') as string,
    (a.show_as_banner ?? a.showAsBanner) ? 'yes' : 'no',
    (a.is_active ?? a.isActive) !== false ? 'yes' : 'no',
    'synced'
  ];
}

export async function createAnnouncementSheet(): Promise<string> {
  const sheets = await getGoogleSheetClient();

  const spreadsheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: 'Ever Club - Announcements'
      },
      sheets: [{
        properties: {
          title: 'Announcements',
          gridProperties: {
            frozenRowCount: 1
          }
        }
      }]
    }
  });

  const spreadsheetId = spreadsheet.data.spreadsheetId!;
  const sheetId = spreadsheet.data.sheets![0].properties!.sheetId!;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1
          },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true }
            }
          },
          fields: 'userEnteredFormat.textFormat.bold'
        }
      }]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Announcements!A1:J1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [HEADER_ROW]
    }
  });

  await db.insert(systemSettings)
    .values({ key: 'announcements_google_sheet_id', value: spreadsheetId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: spreadsheetId, updatedAt: new Date() }
    });

  const allAnnouncements = await db.execute(sql`SELECT * FROM announcements ORDER BY id ASC`);
  const queryResult = allAnnouncements as unknown as { rows: Record<string, unknown>[] };
  const rows = queryResult.rows || (allAnnouncements as unknown as Record<string, unknown>[]);

  if (rows.length > 0) {
    const dataRows = rows.map((a: Record<string, unknown>) => announcementToRow(a));
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Announcements!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: dataRows
      }
    });

    for (let i = 0; i < rows.length; i++) {
      await db.update(announcements)
        .set({ googleSheetRowId: i + 2 })
        .where(eq(announcements.id, rows[i].id as number));
    }
  }

  return spreadsheetId;
}

export async function getLinkedSheetId(): Promise<string | null> {
  const result = await db.select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'announcements_google_sheet_id'))
    .limit(1);

  return result[0]?.value || null;
}

export function getSheetUrl(sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}`;
}

export async function syncFromSheet(sheetId: string): Promise<{ created: number; updated: number; errors: string[] }> {
  const sheets = await getGoogleSheetClient();
  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Announcements!A:J'
  });

  const allRows = response.data.values || [];
  if (allRows.length <= 1) {
    return { created, updated, errors };
  }

  const dataRows = allRows.slice(1);
  const validLinkTypes = ['events', 'wellness', 'golf', 'external', ''];
  const statusUpdates: { range: string; values: string[][] }[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowIndex = i + 2;

    try {
      const appId = row[0] ? parseInt(row[0], 10) : 0;
      const title = row[1] || '';
      const description = row[2] || '';
      const startDate = row[3] || '';
      const endDate = row[4] || '';
      let linkType = (row[5] || '').trim().toLowerCase();
      const linkTarget = row[6] || '';
      const bannerStr = (row[7] || '').trim().toLowerCase();
      const activeStr = (row[8] || '').trim().toLowerCase();

      if (!title) {
        continue;
      }

      if (linkType && !validLinkTypes.includes(linkType)) {
        linkType = '';
      }

      const showAsBanner = bannerStr === 'yes' || bannerStr === 'true';
      const isActive = activeStr !== 'no' && activeStr !== 'false';

      const startsAt = startDate ? createPacificDate(startDate, '00:00:00') : null;
      const endsAt = endDate ? createPacificDate(endDate, '23:59:59') : null;

      if (appId && appId > 0) {
        const existing = await db.select().from(announcements).where(eq(announcements.id, appId)).limit(1);
        if (existing.length > 0) {
          await db.execute(sql`
            UPDATE announcements
            SET title = ${title},
                message = ${description},
                starts_at = ${startsAt},
                ends_at = ${endsAt},
                link_type = ${linkType || null},
                link_target = ${linkTarget || null},
                show_as_banner = ${showAsBanner},
                is_active = ${isActive},
                google_sheet_row_id = ${rowIndex}
            WHERE id = ${appId}
          `);
          updated++;
        } else {
          errors.push(`Row ${rowIndex}: App ID ${appId} not found in database`);
          continue;
        }
      } else {
        const result = await db.execute(sql`
          INSERT INTO announcements (title, message, priority, starts_at, ends_at, link_type, link_target, created_by, show_as_banner, is_active, google_sheet_row_id)
          VALUES (
            ${title},
            ${description},
            'normal',
            ${startsAt},
            ${endsAt},
            ${linkType || null},
            ${linkTarget || null},
            'google-sheets',
            ${showAsBanner},
            ${isActive},
            ${rowIndex}
          )
          RETURNING id
        `);
        const resultRows = (result as unknown as { rows?: Record<string, unknown>[] }).rows;
        const newRow = resultRows?.[0] || (result as unknown as Record<string, unknown>[])[0];
        const newId = newRow?.id;

        if (newId) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `Announcements!A${rowIndex}`,
            valueInputOption: 'RAW',
            requestBody: {
              values: [[String(newId)]]
            }
          });
        }
        created++;
      }

      statusUpdates.push({
        range: `Announcements!J${rowIndex}`,
        values: [['synced']]
      });
    } catch (err: unknown) {
      errors.push(`Row ${rowIndex}: ${getErrorMessage(err)}`);
    }
  }

  if (statusUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: statusUpdates
      }
    });
  }

  return { created, updated, errors };
}

export async function syncToSheet(sheetId: string): Promise<{ pushed: number }> {
  const sheets = await getGoogleSheetClient();
  let pushed = 0;

  const allAnnouncements = await db.execute(sql`SELECT * FROM announcements ORDER BY id ASC`);
  const syncResult = allAnnouncements as unknown as { rows: Record<string, unknown>[] };
  const dbRows = syncResult.rows || (allAnnouncements as unknown as Record<string, unknown>[]);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Announcements!A:J'
  });

  const sheetRows = response.data.values || [];
  const existingIds = new Map<number, number>();

  for (let i = 1; i < sheetRows.length; i++) {
    const appId = parseInt(sheetRows[i][0], 10);
    if (appId > 0) {
      existingIds.set(appId, i + 1);
    }
  }

  const updateData: { range: string; values: string[][] }[] = [];
  const newRows: string[][] = [];

  for (const a of dbRows) {
    const rowData = announcementToRow(a);
    const existingRow = existingIds.get(a.id as number);

    if (existingRow) {
      updateData.push({
        range: `Announcements!A${existingRow}:J${existingRow}`,
        values: [rowData]
      });
    } else {
      newRows.push(rowData);
    }
    pushed++;
  }

  if (updateData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updateData
      }
    });
  }

  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Announcements!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: newRows
      }
    });
  }

  return { pushed };
}

export async function pushSingleAnnouncement(sheetId: string, announcement: Record<string, unknown>): Promise<void> {
  const sheets = await getGoogleSheetClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Announcements!A:A'
  });

  const column = response.data.values || [];
  let targetRow = -1;
  const announcementId = String(announcement.id);

  for (let i = 1; i < column.length; i++) {
    if (String(column[i][0]) === announcementId) {
      targetRow = i + 1;
      break;
    }
  }

  const rowData = announcementToRow(announcement);

  if (targetRow > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Announcements!A${targetRow}:J${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [rowData]
      }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Announcements!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: [rowData]
      }
    });
  }
}

export async function deleteFromSheet(sheetId: string, announcementId: string): Promise<void> {
  const sheets = await getGoogleSheetClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Announcements!A:J'
  });

  const rows = response.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(announcementId)) {
      const targetRow = i + 1;
      const emptyRow = ['', '', '', '', '', '', '', '', '', 'deleted'];
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Announcements!A${targetRow}:J${targetRow}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [emptyRow]
        }
      });
      break;
    }
  }
}
