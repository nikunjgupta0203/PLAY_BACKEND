/**
 * Merges every module's Pothos schema into one executable schema.
 * Importing a module's schema/ registers its types and fields on the builder.
 */
import { builder } from './graphql/builder.js';

import './modules/identity/schema/index.js';
import './modules/sport/schema/index.js';
import './modules/profile/schema/index.js';
import './modules/venues/schema/index.js';
import './modules/events/schema/index.js';
import './modules/registration/schema/index.js';
import './modules/payments/schema/index.js';
import './modules/tournament/schema/index.js';
import './modules/scoring/schema/index.js';
import './modules/notifications/schema/index.js';
import './modules/rating/schema/index.js';
import './modules/home/schema/index.js';
import './modules/chat/schema/index.js';
import './modules/organizers/schema/index.js';
import './modules/organizers/schema/hosting.js';
import './modules/organizers/schema/analytics.js';
import './modules/bookings/schema/index.js';
import './modules/admin/schema/index.js';
import './modules/admin/schema/queues.js';

export const schema = builder.toSchema();
