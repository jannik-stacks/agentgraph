---
title: Dashboard controls are thin wrappers over one function in src
status: accepted
check: tests
human: user rule on the backend as source of truth
---
A dashboard control does not get its own logic. The logic lives once in `src/`: one function that
validates its input with an Effect Schema and writes the local backend's files, and starts nothing.
`serve` picks the change up like a hand edit. The API route only checks that the request is a local
JSON write with `localJson`, calls the function and maps its errors to 400 or 404. The studio
imports the same schema to validate before it sends.

Every write route goes through `localJson`: a write from another origin, a non-JSON body or an
oversized one is refused before the function runs. A route that parses the body itself skipped
these checks once.

Bad:

```ts
if (url.pathname === '/api/comments') return Response.json(await comment(hub, await req.json()));
```

Good:

```ts
const body = await localJson(req);
if ('response' in body) return body.response;
return Response.json(await comment(hub, body.input), { status: 201 });
```
