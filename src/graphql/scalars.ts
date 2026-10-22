import { GraphQLScalarType, Kind } from 'graphql';

export const DateTimeScalar = new GraphQLScalarType<Date, string>({
  name: 'DateTime',
  description: 'An ISO-8601 timestamp in UTC.',
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return new Date(value).toISOString();
    throw new TypeError('DateTime must be a Date');
  },
  parseValue(value) {
    if (typeof value !== 'string') throw new TypeError('DateTime must be a string');
    return new Date(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new TypeError('DateTime must be a string');
    return new Date(ast.value);
  },
});

/** A plain JSON object from a variable — never a literal. What it holds is checked by the field that takes it. */
export const JSONObjectScalar = new GraphQLScalarType<Record<string, unknown>, Record<string, unknown>>({
  name: 'JSONObject',
  description: 'A JSON object, sent as a variable. The field that takes it says what may be in it.',
  serialize(value) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new TypeError('JSONObject must be an object');
  },
  parseValue(value) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new TypeError('JSONObject must be an object');
  },
  parseLiteral() {
    throw new TypeError('JSONObject is taken from variables only');
  },
});
