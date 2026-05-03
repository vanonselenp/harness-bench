# Project context

You are building a typed TypeScript client for the Library API.
The OpenAPI spec is in `spec/library-api.yaml`. Your code goes in `src/`.

# Working agreement

- Read the spec before writing code.
- The client should be ergonomic for application developers to use.
- Handle errors meaningfully — surface useful information, don't swallow.
- Write tests for your own work as you go. These are not the tests you
  will be evaluated against, but treat your own tests as load-bearing.
- When you believe the work is complete, stop and say so explicitly.

# Constraints

- TypeScript, strict mode, targeting Node 20+.
- Use the built-in `fetch` (no axios, no node-fetch, no got).
- Do NOT use OpenAPI code generators (`openapi-generator-cli`,
  `openapi-typescript-codegen`, etc.). Write the client by hand.
- Use only dependencies already declared in `package.json`. Do not add
  runtime dependencies. You may add dev dependencies if strictly needed.
- The base URL for the API is configurable; default to
  `http://localhost:4040`.
- For evaluation consistency, export a `LibraryClient` class from
  `src/index.ts`, constructible with `{ baseUrl }`, whose public method names
  exactly match the OpenAPI `operationId`s.
- Provide one ergonomic helper for collecting all books across cursor pages.
  Choose one clear design, for example `listAllBooks(params)`, an async
  iterator such as `iterBooks(params)`, or `listBooks({ autoPaginate: true })`.
- API errors should be structured enough for callers to branch on HTTP status
  and API error code/message.
- `npm run build` must pass. Run `npm test` or comparable local validation
  before declaring the work complete.

# What "complete" looks like

The client should expose a clean API for every operation in the spec,
handle the spec's pagination, polymorphic response, and async payment
flow appropriately, include the all-books pagination helper, and present
errors in a way a calling application can act on.
