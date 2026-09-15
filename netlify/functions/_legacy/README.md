# Legacy handlers

These are Hub's original functions, written against the AWS Lambda handler signature
(`exports.handler = async (event) => ({ statusCode, body })`). Their logic is untouched.

## Why they moved here

Netlify runs a function one of two ways, decided by how it is authored:

- the **Lambda handler signature** puts it in Lambda compatibility mode, which caps the site's
  *entire* environment at AWS Lambda's hard 4KB limit;
- a **default-exported `(Request) => Response`** runs on Netlify's current runtime, which has
  no such cap.

This site went past 4KB — adding the Magnific key, the Visual Studio job secret and the Firebase
database secret on the same day — and every one of the 68 function uploads began failing at the
deploy stage with `invalid parameter for function creation`. Function creation is all-or-nothing,
so nothing deployed at all: production sat on a stale build while the database security fix and
Mani waited behind it.

The limit cannot be raised. It is AWS's, not Netlify's.

## How the wrappers work

Each function keeps its name and lives one directory up as `<name>.mjs`, containing only:

```js
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "./_legacy/<name>.js";

export default withLambda(legacy.handler);
```

`withLambda` is Netlify's own adapter. It converts the incoming `Request` into the Lambda-style
event these handlers expect — method, path, headers, query string, body — and converts the
returned `{ statusCode, headers, body }` back into a `Response`, decoding `isBase64Encoded`
bodies so binary downloads stay binary.

A directory whose name starts with `_` is not deployed as a function, so these files ship as
ordinary bundled code rather than as a second, unreachable copy of every endpoint.

## Working on one of these

Edit the file here. The wrapper is a fixed three lines and should never need touching. A handler
that genuinely wants the modern runtime should move up a level and be written against `Request`
directly, as the background functions and the Visual Studio asset routes already are.
