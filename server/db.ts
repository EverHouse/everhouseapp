import { drizzle } from 'drizzle-orm/node-postgres';
import { pool } from './core/db';
import * as schema from '../shared/schema';

export const db = drizzle(pool, { schema });
