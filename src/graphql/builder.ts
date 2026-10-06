import SchemaBuilder from '@pothos/core';
import RelayPlugin from '@pothos/plugin-relay';
import { DateTimeScalar } from './scalars.js';
import type { Ctx } from './context.js';

/** conventions.md §4 — `first` is capped, on every list, without exception. */
export const MAX_PAGE_SIZE = 50;

export const clampFirst = (first: number | null | undefined, fallback = 20): number =>
  Math.min(Math.max(first ?? fallback, 1), MAX_PAGE_SIZE);

export const builder = new SchemaBuilder<{
  Context: Ctx;
  // Fields are non-null unless a resolver says otherwise. Nullability should be
  // a deliberate statement about the domain, not a framework default.
  DefaultFieldNullability: false;
  Scalars: {
    DateTime: { Input: Date; Output: Date };
    ID: { Input: string; Output: string };
  };
}>({
  defaultFieldNullability: false,
  plugins: [RelayPlugin],
  relay: {
    // Mutations are verb-first payload types (conventions.md §4); Relay's
    // clientMutationId is a Relay-classic artefact we have no use for.
    clientMutationId: 'omit',
    cursorType: 'String',
    // The opaque global ID lives on `nodeId`, leaving `id` as the raw UUID that
    // `playerProfile(id:)` and every mobile deep link already carry.
    idFieldName: 'nodeId',
    nodeQueryOptions: { nullable: true },
    nodesQueryOptions: { nullable: { list: false, items: true } },
  },
});

builder.addScalarType('DateTime', DateTimeScalar);

builder.queryType({});
builder.mutationType({});
