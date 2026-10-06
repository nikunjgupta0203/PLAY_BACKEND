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
