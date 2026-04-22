import { APP, HTTP_CONFIG } from './config.js';

export function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: APP.name,
      version: APP.version,
      description: APP.description,
    },
    servers: [
      {
        url: `http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}`,
        description: 'Local daemon',
      },
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Get daemon health and runtime status',
          responses: {
            '200': {
              description: 'Health payload',
            },
          },
        },
      },
      '/search': {
        post: {
          summary: 'Search across the configured engines',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
                    engines: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: ['ddg', 'bing', 'brave', 'google', 'reddit', 'github', 'wikipedia'],
                      },
                    },
                    verbose: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Search results' },
            '400': { description: 'Bad request' },
            '500': { description: 'Search failure' },
          },
        },
      },
      '/extract': {
        post: {
          summary: 'Extract clean text from a URL',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Extracted content' },
            '400': { description: 'Bad request' },
            '500': { description: 'Extraction failure' },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'Fetch the OpenAPI contract for the HTTP daemon',
          responses: {
            '200': { description: 'OpenAPI document' },
          },
        },
      },
    },
  };
}
