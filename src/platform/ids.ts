/**
 * UUIDv7 primary keys (conventions.md §2): time-sortable for index locality,
 * without exposing a sequential count of your registrations to a competitor.
 */
import { v7 as uuidv7 } from 'uuid';

export const newId = (): string => uuidv7();
