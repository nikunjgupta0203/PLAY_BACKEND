/** Emit the SDL so clients can codegen against it (conventions.md §4). */
import { writeFileSync } from 'node:fs';
import { printSchema, lexicographicSortSchema } from 'graphql';
import { schema } from '../src/schema.js';

writeFileSync('schema.graphql', `${printSchema(lexicographicSortSchema(schema))}\n`);
console.log('Wrote schema.graphql');
// Importing the schema pulls in module singletons (Prisma, the queues). This is a
// codegen script, not a server: exit rather than wait for their handles.
process.exit(0);
