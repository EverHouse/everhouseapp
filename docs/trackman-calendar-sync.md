# Trackman to Google Calendar Sync

This Google Apps Script automatically creates Google Calendar events when Trackman booking notification emails arrive, and removes them when bookings are cancelled. This blocks/unblocks time slots in your app's availability system.

## How It Works

1. Trackman sends a "Booking Paid" notification email → Script creates calendar event
2. Trackman sends a "Booking Cancelled" email → Script removes the calendar event
3. Your app checks Google Calendar for availability → blocked times are hidden
4. Script runs every 5 minutes automatically

## Setup Instructions

### Step 1: Open Google Apps Script

1. Go to [script.google.com](https://script.google.com)
2. Click **New Project**
3. Name it "Trackman Calendar Sync"

### Step 2: Add the Script

Delete any existing code and paste the following:

```javascript
/**
 * Trackman to Google Calendar Sync
 * Creates calendar events from booking emails and removes them on cancellation
 */

// Configuration - UPDATE THESE VALUES
const CONFIG = {
  TRACKMAN_SENDER: 'noreply@trackman.com',
  CALENDAR_NAME: 'Booked Golf',
  PROCESSED_LABEL_PREFIX: 'Trackman-Msg-',
  DAYS_TO_CHECK: 1,
  BOOKING_ID_PREFIX: 'TRACKMAN_ID:'
};

/**
 * Main function - processes both bookings and cancellations
 */
function processTrackmanEmails() {
  const calendar = getOrCreateCalendar(CONFIG.CALENDAR_NAME);
  
  processBookings(calendar);
  processCancellations(calendar);
}

/**
 * Process new booking emails
 */
function processBookings(calendar) {
  const searchQuery = `from:(${CONFIG.TRACKMAN_SENDER}) subject:(Booking Paid) newer_than:${CONFIG.DAYS_TO_CHECK}d`;
  const threads = GmailApp.search(searchQuery);
  
  Logger.log(`Found ${threads.length} booking email threads`);
  
  for (const thread of threads) {
    const messages = thread.getMessages();
    
    for (const message of messages) {
      const messageId = message.getId();
      
      if (isMessageProcessed(messageId)) {
        continue;
      }
      
      const subject = message.getSubject().toLowerCase();
      if (!subject.includes('booking paid')) {
        continue;
      }
      
      try {
        const booking = parseTrackmanEmail(message);
        
        if (booking) {
          booking.messageId = messageId;
          const created = createCalendarEvent(calendar, booking);
          if (created) {
            Logger.log(`Created event: ${booking.customerName} - ${booking.bayName} at ${booking.startTime}`);
          }
        }
        
        markMessageProcessed(messageId);
      } catch (error) {
        Logger.log(`Error processing booking email ${messageId}: ${error.message}`);
      }
    }
  }
}

/**
 * Process cancellation emails
 */
function processCancellations(calendar) {
  const searchQuery = `from:(${CONFIG.TRACKMAN_SENDER}) subject:(Booking Cancelled) newer_than:${CONFIG.DAYS_TO_CHECK}d`;
  const threads = GmailApp.search(searchQuery);
  
  Logger.log(`Found ${threads.length} cancellation email threads`);
  
  for (const thread of threads) {
    const messages = thread.getMessages();
    
    for (const message of messages) {
      const messageId = message.getId();
      
      if (isMessageProcessed(messageId)) {
        continue;
      }
      
      const subject = message.getSubject().toLowerCase();
      if (!subject.includes('booking cancelled') && !subject.includes('booking canceled')) {
        continue;
      }
      
      try {
        const booking = parseTrackmanEmail(message);
        
        if (booking) {
          const deleted = deleteCalendarEvent(calendar, booking);
          if (deleted) {
            Logger.log(`Deleted event: ${booking.customerName} at ${booking.startTime}`);
          }
        }
        
        markMessageProcessed(messageId);
      } catch (error) {
        Logger.log(`Error processing cancellation email ${messageId}: ${error.message}`);
      }
    }
  }
}

/**
 * Parse Trackman booking email to extract booking details
 */
function parseTrackmanEmail(message) {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const htmlBody = message.getBody();
  
  const subjectNormalized = subject.toLowerCase();
  let subjectMatch;
  
  if (subjectNormalized.includes('booking paid')) {
    subjectMatch = subject.match(/Booking\s+Paid[:\s]*(.+?)\s+at\s+(.+)/i);
  } else if (subjectNormalized.includes('booking cancel')) {
    subjectMatch = subject.match(/Booking\s+Cancel(?:led|ed)[:\s]*(.+?)\s+at\s+(.+)/i);
  }
  
  let customerName = 'Unknown Customer';
  if (subjectMatch) {
    customerName = subjectMatch[1].trim();
  }
  
  const booking = {
    customerName: customerName,
    customerEmail: '',
    bayName: '',
    bayRef: '',
    startTime: null,
    endTime: null,
    messageId: null
  };
  
  const emailPatterns = [
    /\*\*Email:\*\*\s*([^\s\n<]+@[^\s\n<]+)/i,
    /Email:\s*([^\s\n<]+@[^\s\n<]+)/i,
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/
  ];
  
  for (const pattern of emailPatterns) {
    const match = body.match(pattern) || htmlBody.match(pattern);
    if (match) {
      booking.customerEmail = match[1].trim();
      break;
    }
  }
  
  const bayPatterns = [
    /For\s+(.+?)\s+on\s+bay[:\s]*(\S+)/i,
    /Bay[:\s]+(\S+)/i,
    /\*\*Bay:\*\*\s*(\S+)/i
  ];
  
  for (const pattern of bayPatterns) {
    const match = body.match(pattern) || htmlBody.match(pattern);
    if (match) {
      if (match[2]) {
        booking.bayName = match[1].trim();
        booking.bayRef = match[2].trim();
      } else {
        booking.bayRef = match[1].trim();
        booking.bayName = `Bay ${booking.bayRef}`;
      }
      break;
    }
  }
  
  const timePatterns = [
    /\*\*Time:\*\*\s*(.+?)\s+to\s+(.+?)(?:\n|<|$)/i,
    /Time:\s*(.+?)\s+to\s+(.+?)(?:\n|<|$)/i,
    /Time:\s*(.+?)\s*[-–—]\s*(.+?)(?:\n|<|$)/i
  ];
  
  for (const pattern of timePatterns) {
    const match = body.match(pattern) || htmlBody.match(pattern);
    if (match) {
      booking.startTime = parseDateTime(match[1].trim());
      booking.endTime = parseDateTime(match[2].trim());
      break;
    }
  }
  
  if (!booking.startTime && subjectMatch && subjectMatch[2]) {
    booking.startTime = parseDateTime(subjectMatch[2].trim());
    if (booking.startTime) {
      booking.endTime = new Date(booking.startTime.getTime() + 60 * 60 * 1000);
    }
  }
  
  if (!booking.startTime) {
    Logger.log('Could not parse booking time from email');
    Logger.log('Subject: ' + subject);
    Logger.log('Body preview: ' + body.substring(0, 300));
    return null;
  }
  
  return booking;
}

/**
 * Parse various date/time formats
 */
function parseDateTime(dateTimeStr) {
  if (!dateTimeStr) return null;
  
  dateTimeStr = dateTimeStr.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  
  let date = new Date(dateTimeStr);
  if (!isNaN(date.getTime())) {
    return date;
  }
  
  const monthNames = {
    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
  };
  
  const match1 = dateTimeStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (match1) {
    const monthStr = match1[1].toLowerCase().substring(0, 3);
    const month = monthNames[monthStr];
    if (month !== undefined) {
      let hour = parseInt(match1[4]);
      const minute = parseInt(match1[5]);
      const ampm = match1[7];
      
      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
        if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
      }
      
      return new Date(parseInt(match1[3]), month, parseInt(match1[2]), hour, minute);
    }
  }
  
  const match2 = dateTimeStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (match2) {
    let hour = parseInt(match2[4]);
    const minute = parseInt(match2[5]);
    const ampm = match2[6];
    
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    }
    
    return new Date(parseInt(match2[3]), parseInt(match2[1]) - 1, parseInt(match2[2]), hour, minute);
  }
  
  Logger.log(`Could not parse date: ${dateTimeStr}`);
  return null;
}

/**
 * Generate unique booking ID for idempotency
 */
function generateBookingId(booking) {
  const startStr = booking.startTime.toISOString();
  const key = `${booking.bayRef || 'unknown'}_${startStr}_${booking.customerEmail || booking.customerName}`;
  return CONFIG.BOOKING_ID_PREFIX + key;
}

/**
 * Create a calendar event for the booking
 */
function createCalendarEvent(calendar, booking) {
  const bookingId = generateBookingId(booking);
  
  const searchStart = new Date(booking.startTime.getTime() - 60000);
  const searchEnd = new Date(booking.endTime.getTime() + 60000);
  const existingEvents = calendar.getEvents(searchStart, searchEnd);
  
  for (const event of existingEvents) {
    const desc = event.getDescription() || '';
    if (desc.includes(bookingId)) {
      Logger.log(`Event already exists with ID: ${bookingId}`);
      return false;
    }
  }
  
  const title = booking.bayRef 
    ? `${booking.bayName} (${booking.bayRef}) - ${booking.customerName}`
    : `${booking.bayName || 'Trackman'} - ${booking.customerName}`;
  
  const description = [
    `Customer: ${booking.customerName}`,
    booking.customerEmail ? `Email: ${booking.customerEmail}` : '',
    booking.bayName ? `Bay: ${booking.bayName}` : '',
    booking.bayRef ? `Bay Ref: ${booking.bayRef}` : '',
    '',
    'Booked via Trackman',
    '',
    bookingId
  ].filter(Boolean).join('\n');
  
  const event = calendar.createEvent(title, booking.startTime, booking.endTime, {
    description: description
  });
  
  event.setColor(CalendarApp.EventColor.GREEN);
  
  return true;
}

/**
 * Delete a calendar event for a cancelled booking
 */
function deleteCalendarEvent(calendar, booking) {
  const bookingId = generateBookingId(booking);
  
  const searchStart = new Date(booking.startTime.getTime() - 60000);
  const searchEnd = new Date(booking.endTime.getTime() + 60000);
  const events = calendar.getEvents(searchStart, searchEnd);
  
  let deleted = false;
  
  for (const event of events) {
    const desc = event.getDescription() || '';
    const title = event.getTitle() || '';
    
    if (desc.includes(bookingId)) {
      event.deleteEvent();
      deleted = true;
      Logger.log(`Deleted event by ID: ${bookingId}`);
      break;
    }
    
    if (title.includes(booking.customerName) && 
        Math.abs(event.getStartTime().getTime() - booking.startTime.getTime()) < 60000) {
      event.deleteEvent();
      deleted = true;
      Logger.log(`Deleted event by name/time match: ${title}`);
      break;
    }
  }
  
  if (!deleted) {
    Logger.log(`No matching event found to delete for: ${booking.customerName} at ${booking.startTime}`);
  }
  
  return deleted;
}

/**
 * Check if a specific message has been processed
 */
function isMessageProcessed(messageId) {
  const labelName = CONFIG.PROCESSED_LABEL_PREFIX + messageId.substring(0, 10);
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(messageId) === 'processed';
}

/**
 * Mark a specific message as processed
 */
function markMessageProcessed(messageId) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(messageId, 'processed');
}

/**
 * Get or create a calendar
 */
function getOrCreateCalendar(calendarName) {
  const calendars = CalendarApp.getCalendarsByName(calendarName);
  if (calendars.length > 0) {
    return calendars[0];
  }
  
  Logger.log(`Creating calendar: ${calendarName}`);
  return CalendarApp.createCalendar(calendarName);
}

/**
 * Set up automatic trigger to run every 5 minutes
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processTrackmanEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  
  ScriptApp.newTrigger('processTrackmanEmails')
    .timeBased()
    .everyMinutes(5)
    .create();
  
  Logger.log('Trigger created - script will run every 5 minutes');
}

/**
 * Remove the automatic trigger
 */
function removeTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processTrackmanEmails') {
      ScriptApp.deleteTrigger(trigger);
      Logger.log('Trigger removed');
    }
  }
}

/**
 * Clear all processed message records (use if you need to reprocess emails)
 */
function clearProcessedRecords() {
  const props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  Logger.log('Cleared all processed message records');
}

/**
 * Test function - run manually to test parsing
 */
function testWithLatestEmail() {
  const threads = GmailApp.search('subject:(Booking)', 0, 1);
  if (threads.length === 0) {
    Logger.log('No booking emails found');
    return;
  }
  
  const message = threads[0].getMessages()[0];
  Logger.log('Subject: ' + message.getSubject());
  Logger.log('From: ' + message.getFrom());
  Logger.log('Body preview: ' + message.getPlainBody().substring(0, 500));
  
  const booking = parseTrackmanEmail(message);
  Logger.log('Parsed booking: ' + JSON.stringify(booking, null, 2));
  
  if (booking) {
    Logger.log('Generated ID: ' + generateBookingId(booking));
  }
}

/**
 * Test cancellation handling
 */
function testCancellation() {
  const threads = GmailApp.search('subject:(Booking Cancelled)', 0, 1);
  if (threads.length === 0) {
    Logger.log('No cancellation emails found');
    return;
  }
  
  const message = threads[0].getMessages()[0];
  Logger.log('Subject: ' + message.getSubject());
  
  const booking = parseTrackmanEmail(message);
  Logger.log('Parsed cancellation: ' + JSON.stringify(booking, null, 2));
}
```

### Step 3: Configure the Script

Update the `CONFIG` object at the top:

```javascript
const CONFIG = {
  TRACKMAN_SENDER: 'noreply@trackman.com',  // Trackman's email address
  CALENDAR_NAME: 'Booked Golf',              // Your calendar name
  PROCESSED_LABEL_PREFIX: 'Trackman-Msg-',   // Prefix for tracking
  DAYS_TO_CHECK: 1,                          // How far back to check
  BOOKING_ID_PREFIX: 'TRACKMAN_ID:'          // ID prefix for events
};
```

### Step 4: Authorize the Script

1. Click **Run** > **processTrackmanEmails**
2. Click **Review Permissions**
3. Select your Google account
4. Click **Advanced** > **Go to Trackman Calendar Sync (unsafe)**
5. Click **Allow**

### Step 5: Set Up Automatic Trigger

1. Click **Run** > **setupTrigger**
2. The script will now run automatically every 5 minutes

### Step 6: Test It

1. Click **Run** > **testWithLatestEmail** to test with an existing email
2. Check the **Execution log** (View > Executions) for results
3. Check your "Booked Golf" calendar for created/deleted events

## Features

### Booking Creation
- Parses "Booking Paid" emails and creates calendar events
- Events are color-coded green for visibility
- Unique ID stored in description prevents duplicates

### Cancellation Handling
- Parses "Booking Cancelled" emails
- Automatically removes matching calendar events
- Time slots become available again in your app

### Idempotency
- Each message is tracked individually (not by thread)
- Duplicate events are prevented using unique booking IDs
- Safe to run multiple times without side effects

## Troubleshooting

### Emails Not Being Detected
- Verify `TRACKMAN_SENDER` matches the actual sender email address
- Check that subjects contain "Booking Paid" or "Booking Cancelled"
- Run `testWithLatestEmail` to see what the script finds

### Events Not Being Deleted on Cancellation
- The cancellation email must have the same customer name and time
- Run `testCancellation` to see if parsing works
- Check the Execution log for any errors

### Need to Reprocess Emails
- Run **clearProcessedRecords** to reset the tracking
- Then run **processTrackmanEmails** again

### Calendar Events Not Showing in App
- Verify the calendar name matches exactly what your app expects
- Check that the Google account used by the app has access to the calendar

## Viewing Logs

1. Go to **View** > **Executions**
2. Click on any execution to see detailed logs
3. Look for created/deleted events and any parsing errors

## Stopping the Sync

To stop automatic syncing:
1. Open the script
2. Click **Run** > **removeTrigger**
