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
the working directory, so it takes your `name` and `client_token` from the
manifest you already ship.

The platform re-reads the manifest after each deploy, so publishing
your bundle is what registers it. If Brass hosts your bundle
(`brass publish`), it reads the manifest from the bytes it stores, so
your capabilities register even when your load gate is on. If you serve
the bundle from your own origin, the platform fetches
`<origin>/.well-known/brass-app.json` as an anonymous client, so serve
that path publicly even when the rest of your app requires sign-in.

The `opens` and `creates` tokens below only drive discovery and grant
no access, so you declare them yourself.

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

- **`opens`** lists the `schema_type`s of documents your app reads.
  Declaring a `schema` already folds its family in, so most apps list
  nothing extra here.
- **`imports`** matches an uploaded file by extension or content type,
  so Brass offers your app to whoever uploads one. Your app then reads
  the file's bytes through `sourceBlob()`.
- **`creates`** is the `schema_type` Brass stamps on the documents your
  app makes, so peer apps that declare `opens` for the token can open
  them. It folds into your own `opens` as well.
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

A field is one value the person connecting a credential is asked for. Each one
is a box on the form they fill in.

Some authentication methods declare their own fields, and each method below
lists the ones it declares. Declare any others in `fields`:

| Property | |
| --- | --- |
| `name` | Required. Identifies the field. |
| `secret` | `true` by default. Brass encrypts the value and shows only its last few characters afterwards. `false` stores it in the clear and shows it in full. |
| `label` | What the form calls the field. Use the vendor's own word for it, since that is what the person is reading from. Defaults to the name. |
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

Some services take a fixed word as the user half rather than an account name,
such as `api` for Mailgun. Set it as `username` on the `auth` block and the
person is asked for the password alone.

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
