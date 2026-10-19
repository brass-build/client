# The capability manifest (`brass-app.json`)

Every app ships a `brass-app.json`, and the platform reads it to decide
where your app shows up. Brass adds an "Open in" link to a document
card, offers your app when someone uploads a file it handles, and shows
a download button on the documents your app writes out.

## Where it goes

Put `brass-app.json` in a `/.well-known/` directory at your bundle
root, next to `index.html`. In Vite, `public/.well-known/brass-app.json`
builds to `dist/.well-known/brass-app.json`. Check it is there after you
build: a bundler that skips dot-directories drops it silently.

`brass publish` reads that same path out of the directory it publishes
(`<dir>/.well-known/brass-app.json`), falling back to `brass-app.json` in
the working directory, and refuses to publish a manifest whose `$ref`
entries do not resolve.

The platform re-reads the manifest after each deploy, so publishing
your bundle is what registers it. If Brass hosts your bundle
(`brass publish`), it reads the manifest from the bytes it stores, so
your capabilities register even when your load gate is on. If you serve
the bundle from your own origin, the platform fetches
`<origin>/.well-known/brass-app.json` as an anonymous client, so serve
that path publicly even when the rest of your app requires sign-in.

Brass applies your published manifest, including to your app running
on your own machine, so publish after every change to it.

Brass uses `opens`, `inputs` and `creates` below to decide where to
offer your app. Declaring them grants your app no access to any
document.

## What goes in it

```json
{
  "opens": ["tracker"],
  "imports": [{ "extension": "csv" }, { "content_type": "text/csv" }],
  "creates": "tracker",
  "exports": { "content_type": "text/csv", "file_extension": ".csv" },
  "icon": "/icon.svg",
  "services": [{ "host": "api.anthropic.com", "headers": { "x-api-key": "{secret}" } }],
  "schema": {
    "family": "tracker",
    "streams": { "default": { "type": "object", "required": ["rows"] } }
  }
}
```

Every field is optional, so ship only the ones your app uses.

- **`opens`** lists the families of documents your app opens as
  the document a user is working in. Brass offers your app in "Open
  with" for them, and a user can make it their default. Declaring a `schema`
  already folds its family in, so most apps list nothing extra here.
- **`inputs`** lists the schemas your app reads as inputs, such as the
  models and drawings a dashboard counts. Each entry is a schema,
  `{ "family", "streams" }`. The hosted picker presents a document to the
  user when it matches one of these schemas (see
  [What an app can open](./schemas.md#what-an-app-can-open)). For files that
  have not been imported yet, the picker evaluates compatibility against the
  schema declared by the file's importer. A schema declared only under
  `inputs` does not add your app to the "Open with" menu for those documents.
  Declare a schema under `inputs` rather than its family under `opens`
  when your app reads documents through `Brass.chooseInputs` and never
  edits them. Extract the schema from an existing document with
  `npx @brass-build/cli schema pull --doc <docId> --out input-schema.json`,
  which writes to that file while leaving your manifest's own `schema`
  intact. Copy that file's `schema` into an `inputs` entry, then trim it to
  only the required fields your code reads, since fewer requirements match
  a wider set of documents.

  ```json
  {
    "inputs": [
      {
        "family": "ifc",
        "streams": { "default": { "type": "object", "required": ["instances"] } }
      }
    ]
  }
  ```

- **`imports`** lists the file types your app imports. Brass offers your app
  to whoever uploads a matching file and passes the file to your
  `Brass.registerImporter` callback. Each entry has these fields:

  | Field | |
  | --- | --- |
  | `extension` | The file extension to match, without the dot, in any case, such as `"csv"`. |
  | `content_type` | The media type to match exactly, such as `"text/csv"`. |
  | `schema` | Optional. The schema of the document your importer makes from a matching file. Without it, your app's `schema` applies. |

  An entry needs `extension` or `content_type`, and a file matches an entry
  when it matches every field the entry sets. A file whose entry has no
  `schema`, in an app with no `schema`, is not imported.
- **`creates`** is the family Brass stamps on the documents your
  app makes, so peer apps that declare `opens` for that family can open
  them. It folds into your own `opens` as well. When you declare a
  `schema`, Brass stamps `schema.family` instead, so either leave
  `creates` out or set it to the same family. `brass publish` warns
  when the two differ.
- **`exports`** names the file format your app writes a document out
  to, and your `Brass.registerSerializer` callback produces the bytes.
  Declaring it makes those documents downloadable. Declare it when your
  app interoperates with a format outside Brass.
  [`imported-documents.md`](./imported-documents.md) covers how an
  importing app chooses that format.
- **`icon`** points at your app's mark, which the platform renders on
  your app's tiles and on the hosted consent screen when someone grants
  your app access. Draw a small SVG and serve it from your own bundle
  (`"icon": "/icon.svg"`, resolved against your origin), or give an
  absolute `https://` URL. An emoji (`"icon": "🏗️"`) also renders,
  though apps in one domain tend to land on the same few.
- **`services`** names the third-party APIs your app calls. Brass proxies
  each call, using either your credentials or the user's. See
  [Services](#services-for-calling-third-party-apis) below.
- **`schema`** declares the record shape your app works with, whether
  you designed it or adopted an existing one. See
  [`schemas.md`](./schemas.md).
- **`shared_schemas`** defines schemas by name for other fields to refer
  to. See [Shared schemas](#shared-schemas) below.
- **`access`** says who may use your app. Declare `"create": "anyone"`
  when a visitor who is not signed in can do something in your app, so
  they can try it before creating an account. A visitor belongs to no
  organization, so `Brass.chooseInputs`, `Brass.chooseInput` and calls to
  a service your manifest declares are not available to them.

  | Field | Values |
  | --- | --- |
  | `create` | Who may start a new document in your app. `false` when your app makes no new documents of its own, such as a viewer of files other apps import: Brass then offers no New for it, and if your app calls `Brass.createDocument` anyway, the call throws a `BrassError` whose `code` is `"create_not_offered"`. Brass still opens uploaded and imported files in it. `"signed-in"` for people who are signed in. `"anyone"` adds visitors without an account, who can create, upload and edit temporary documents. For `"anyone"`, publish the app with `--gate off --visibility public`. |
  | `open` | Who may open an organization's public link in your app: `"anyone"`, or `"signed-in"` to ask a visitor to sign in first. |

  When you leave `create` out, Brass uses `"anyone"` for a public app
  whose load gate is off and `"signed-in"` otherwise, so declare it to
  keep the same answer when the gate changes. When you leave `open` out,
  Brass uses `"anyone"`.

  ```json
  { "access": { "create": "anyone", "open": "anyone" } }
  ```

  The hosted load gate (`brass publish --gate on|off`) is separate from
  `access`: it decides whether your hosted bundle loads for a visitor who
  is not signed in, before any of your code or this manifest runs.

## Shared schemas

Define schemas by name in `shared_schemas`. To use one, write
`{ "$ref": "#/shared_schemas/<name>" }` in place of a schema in `schema`, a
`inputs` entry, or an `imports` entry's `schema`. Brass treats a reference as
the schema it names.

This app writes `tracker` documents, reads as inputs any tracker that has
`rows`, and imports CSV files as `csv-table` documents that it also reads
as inputs:

```json
{
  "shared_schemas": {
    "tracker": {
      "family": "tracker",
      "streams": { "default": { "type": "object", "required": ["rows", "columns"] } }
    },
    "tracker-input": {
      "family": "tracker",
      "streams": { "default": { "type": "object", "required": ["rows"] } }
    },
    "csv-table": {
      "family": "csv-table",
      "streams": { "default": { "type": "object", "required": ["header", "rows"] } }
    }
  },
  "schema": { "$ref": "#/shared_schemas/tracker" },
  "inputs": [{ "$ref": "#/shared_schemas/tracker-input" }, { "$ref": "#/shared_schemas/csv-table" }],
  "imports": [{ "extension": "csv", "schema": { "$ref": "#/shared_schemas/csv-table" } }]
}
```

## Services, for calling third-party APIs

`services` names the third-party APIs that your app calls. Each service
declaration includes a host name and an authentication method. Brass then
proxies each call, using either your credentials or the user's, so no secret
is exposed in the client.

```json
{
  "services": [
    { "host": "api.anthropic.com", "headers": { "x-api-key": "{secret}" } },
    { "host": "api.example.com", "headers": { "authorization": "Bearer {secret}" } }
  ]
}
```

[`services.md`](./services.md) covers the calling side: what each refusal code
means, how to prompt for a missing credential, which host to pass for a
service split across addresses, and how to provide setup instructions for
the people who supply your credentials.

### Specifying a host

`host` is the host name your app passes to `Brass.callService`. It must be a
public https host: no scheme, no port, no path.

Use a wildcard where a service is split across subdomains (`*.example.com`).
Your app can then call any address under that suffix.

Set `credentialPerHost` to give each address its own credential. Without it,
one credential covers every address under the wildcard. With it, the user
enters a separate credential for each address, which is what a vendor that
hosts a separate address per account requires.

```json
{
  "services": [
    { "host": "*.example.com", "headers": { "authorization": "Bearer {secret}" } },
    {
      "host": "*.myshopify.com",
      "credentialPerHost": true,
      "headers": { "x-shopify-access-token": "{secret}" }
    }
  ]
}
```

`credentialPerHost` is required for a suffix that anyone can register a name
under. One credential covering `*.herokuapp.com` or `*.pages.dev` could be
used at an address a stranger created, so Brass rejects that declaration and
reports it on your next publish. The same rule limits a shared wildcard:
`*.amazonaws.com` can call `sts.amazonaws.com` and
`lambda.us-west-2.amazonaws.com`, but not `any-bucket.s3.amazonaws.com`,
because that name belongs to whoever created the bucket.

### Credential fields

A field is one value the user connecting a credential is asked for. Each one
is a box on the form they fill in.

Some authentication methods declare their own fields, and each method below
lists the ones it declares. Declare any others in `fields`:

| Property | |
| --- | --- |
| `name` | Required. Identifies the field. |
| `secret` | `true` by default. Brass encrypts the value and shows only its last few characters afterwards. `false` stores it in the clear and shows it in full. |
| `label` | What the form calls the field. Use the vendor's own word for it, since that is what the user is reading from. Defaults to the name. |
| `readable` | `false` by default. `true` returns the value to your app with the service, for a value your app has to include in the request. Such a field is not secret, so `secret` defaults to `false` for it and declaring both is refused. See [Values the app reads](./services.md#values-the-app-reads). |

```json
{
  "services": [
    {
      "host": "api.example.com",
      "headers": { "x-app": "{app_id}", "x-region": "{region}", "x-key": "{key}" },
      "fields": [
        { "name": "app_id", "secret": false, "label": "Application ID" },
        { "name": "region", "secret": false, "label": "Region" }
      ]
    }
  ]
}
```

An entry naming a field the method already declared changes that field's
properties instead of adding a new one, which is how you relabel one. A field
the method declares secret stays secret.

### Choosing an authentication method

A credential sent in a plain header needs no `auth` block. Every other method
is an `auth` block naming its `type`.

#### `headers`, for a credential sent in a header

Each header value is a template, and Brass substitutes a field into each
placeholder you write. The fields are the names in those placeholders; this
method declares none of its own.

```json
{
  "services": [
    {
      "host": "production.plaid.com",
      "headers": {
        "plaid-client-id": "{client_id}",
        "plaid-secret": "{secret}"
      },
      "fields": [{ "name": "client_id", "secret": false, "label": "Client ID" }]
    }
  ]
}
```

#### `basic`, for HTTP basic auth

Brass sends `authorization: Basic base64(username:password)`.

The fields are `username` and `password`.

```json
{ "host": "api.twilio.com", "auth": { "type": "basic" } }
```

Some services take a fixed word as the username rather than an account name,
such as `api` for Mailgun. Set it as `username` on the `auth` block and the
form asks for the password alone.

```json
{ "host": "api.mailgun.net", "auth": { "type": "basic", "username": "api" } }
```

#### `query`, for a credential sent as a query parameter

Brass appends these parameters to the query your app wrote, substituting a
field into each placeholder you write. The fields are the names in those
placeholders; this method declares none of its own.

```json
{
  "host": "maps.example.com",
  "auth": { "type": "query", "params": { "key": "{secret}" } }
}
```

#### `aws_sigv4`, for a signed AWS request

Brass signs the request, so the secret never leaves Brass.

The fields are `access_key_id` and `secret_access_key`.

```json
{ "host": "*.amazonaws.com", "auth": { "type": "aws_sigv4" } }
```

AWS puts the region and the service in most of its host names, and Brass signs
for whichever the address names. Set `region` and `service` for addresses that
name neither, such as a bucket or an account id before the service name. Brass
uses them only where the host name does not say, so one credential still
covers a whole suffix.

#### `oauth2_client_credentials`, for a token from your client credentials

You register a client with the vendor. Brass posts the client id and secret to
the token endpoint, receives a short-lived token, and sends that token with
each call. Set `clientAuth` to `body` or `basic` to say where the id and
secret go; vendors differ, and many accept only one.

The fields are `client_id` and `client_secret`.

```json
{
  "host": "api.xero.com",
  "auth": {
    "type": "oauth2_client_credentials",
    "tokenHost": "identity.xero.com",
    "tokenPath": "/connect/token",
    "clientAuth": "basic",
    "scope": "accounting.transactions"
  }
}
```

#### `jwt_bearer`, for a token from a signed assertion

Brass signs a short-lived assertion with a private key, so the key never
leaves Brass. Set `audience` to the string the vendor requires in the
assertion. Vendors are strict about this value, so declare it rather than
letting Brass build one.

The fields are `issuer` and `private_key`.

```json
{
  "host": "oauth2.googleapis.com",
  "auth": {
    "type": "jwt_bearer",
    "tokenPath": "/token",
    "audience": "https://oauth2.googleapis.com/token",
    "algorithm": "RS256"
  }
}
```

Both token methods take two more fields:

- `tokenPath` names the path on the credential's own host. Set `tokenUrl`
  instead to name the whole address. `tokenHost` defaults to the credential's
  own host.
  Set it to post the exchange to a different host. Brass allows this for a
  credential you supply, and rejects it for one the user supplies, unless the
  user chose the method. Otherwise your manifest would decide where their
  secret is sent.
- `tokenBody` sets how the exchange is posted: `form` (the default) or `json`.
  Set `json` when your vendor's token endpoint takes a JSON body.

#### `oauth2_authorization_code`, for a per-user approval at the vendor

Each user approves at the vendor, and Brass stores the result for that user
alone. Your app then reaches only what that user can reach. Use this at a host
whose permissions differ per user, where one shared account would reach
everything.

The fields are `client_id` and `client_secret`, which are your registered
OAuth client rather than anything the approving user enters.

```json
{
  "host": "api.example.com",
  "auth": {
    "type": "oauth2_authorization_code",
    "authorizationUrl": "https://app.example.com/oauth/authorize",
    "tokenUrl": "https://api.example.com/oauth/token",
    "clientAuth": "basic"
  }
}
```

- `clientAuth` sets where your client id and secret go on the exchange: `body`
  or `basic`.
- `authorizeParams` adds parameters the vendor requires on the approval
  request. Many vendors issue no refresh token without one, and the connection
  then stops working when the first token expires. Google requires
  `{"access_type": "offline", "prompt": "consent"}`. Read your vendor's
  documentation on refresh tokens before you ship this.
- `pkce` defaults to `true`. Set `false` for a vendor that rejects the
  challenge.

You supply an OAuth client registered with the vendor, entering its id and
secret like any other credential. Register
`https://brass.build/services/oauth/callback` as the redirect URL. That one
address serves every service, and there is nothing to configure in Brass.

Calls return `409` with `credential_required` until the user approves.
[`services.md`](./services.md) covers prompting them.

#### An OpenAPI security scheme

`auth` also accepts an OpenAPI `securityScheme`, so you can paste what your
vendor's spec already says. Brass reads it as the equivalent method above:
`apiKey` and `http` `bearer` take a single `secret` field, sent in the place
the spec names; `http` `basic` reads as `basic`; and the `clientCredentials`
and `authorizationCode` flows read as their OAuth methods, with those methods'
fields.

```json
{ "host": "api.example.com", "auth": { "type": "apiKey", "in": "header", "name": "X-API-Key" } }
```

The `authorizationCode` flow is the same grant as `oauth2_authorization_code`
above. A spec carries no `clientAuth`, `authorizeParams` or `pkce`, so set
those alongside `flows`:

```json
{
  "host": "api.example.com",
  "auth": {
    "type": "oauth2",
    "flows": {
      "authorizationCode": {
        "authorizationUrl": "https://app.example.com/oauth/authorize",
        "tokenUrl": "https://api.example.com/oauth/token",
        "scopes": { "contacts.read": "Read contacts" }
      }
    }
  }
}
```

#### More than one method at one host

Set `auth` to an array where a host accepts more than one kind of credential.
A user with an API key can then use it at a host you declared for approval:

```json
{
  "host": "api.example.com",
  "auth": [
    { "type": "oauth2", "flows": { "authorizationCode": { "...": "..." } } },
    { "type": "apiKey", "in": "header", "name": "X-API-Key" }
  ]
}
```

Brass uses your first entry by default. The user can choose another when they
enter their credential, and Brass then asks for whatever that method needs.

Set `authorOnly` on an entry to keep it out of the user's choices. Use it for
a credential only you can obtain, such as a vendor's internal-integration
secret, which authenticates as your account rather than theirs.

A host often accepts several kinds of credential. A vendor that issues both
personal tokens and OAuth clients takes either, and they are different
credentials at one address. Declare the method your app is built around. A
user who pastes an OAuth client pair where you declared a bearer token is
asked for the client id as well, and your app keeps calling one host.
