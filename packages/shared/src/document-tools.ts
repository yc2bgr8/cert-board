import {
  documentPageParamsSchema,
  documentPageReadOptionsSchema,
  documentSearchOptionsSchema,
} from './documents.js';

export const docSearchToolInputSchema = documentSearchOptionsSchema;
export const docReadToolInputSchema = documentPageParamsSchema
  .extend({
    ...documentPageReadOptionsSchema.shape,
    limit: documentPageReadOptionsSchema.shape.limit.unwrap().default(1800),
  })
  .strict();
