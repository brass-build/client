# Calling an outside service

The README's [Calling an outside service](../README.md#calling-an-outside-service)
covers how to make a call. This page covers what each refusal code means,
how to read values only the user knows, and which host to pass for a service
split across several addresses. [`app-manifest.md`](./app-manifest.md) covers
declaring a host and its authentication method.

## What comes back

`callService` returns the service's response unchanged, within these limits:

- Text only, up to 5 MB, within 25 seconds.
- No streaming. A streaming endpoint's events all arrive together at the end.
- For binary data, call an endpoint that returns a URL or base64.
- Brass does not follow redirects. A `3xx` is returned as
  `response_redirected`, with the service's `location` in the body.

`options.method` defaults to `'POST'`.

## Refusal codes

When Brass refuses a call rather than sending it, the response body has a
`code`:

```js
const res = await Brass.callService(host, path);
if (!res.ok) {
  const { code } = await res.json();
  if (code === 'credential_required') await Brass.connectService(host);
}
```

Each code always comes with the same HTTP status, so branching on the code
is enough. Two answers carry no code, and both mean the hop to the service
itself did not complete: a `502` where Brass could not reach the service, and
a `504` where the service did not answer in time. Other `502`s do carry a
code, so read the body before treating one as unreachable.

**Somebody using your app can supply what is missing.** Call
`Brass.connectService(host)`. The dialog asks whoever opened it for whatever
the host needs, and tells anyone who cannot answer who to ask.

| `code`                | What it means                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `credential_required` | No credential is connected for this host, or the one connected is not approved for your app, no longer covers what your app sends, or carries no value under a name your app reads back. One code, because the dialog is the answer to all of them. The body's sentence says which, for a user to read. |

**Your own key is what is missing.** These are yours to settle on your app's
settings page, so there is nothing to raise on the page: report the feature as
unavailable.

| `code`                       | What it means                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `app_credential_not_set`     | You have not entered a key for this service yet. This is the refusal you get by default, until you enter one or hand the service over for whoever runs your app to connect. |
| `app_credential_incomplete`  | Your own key carries no value under a name your manifest asks for.                                         |

**A stored credential is there and does not work.**

| `code`                       | What it means                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `credential_rejected`        | The service rejected the stored credential.                                                                |
| `credential_scheme_unusable` | The host's credential is not usable as configured.                                                         |
| `credential_exchange_failed` | Brass could not reach the service for a token, or got back something that was not one.                     |
| `credential_unreadable`      | Brass cannot read the credential stored here. Enter it again.                                              |

**The call itself is not allowed.** Fix these in your app.

| `code`                    | What it means                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `service_not_declared`    | Your manifest does not declare that host, or your latest publish has not registered it.                    |
| `path_invalid`            | The path names its own host, escapes the service with `..`, or cannot be decoded.                           |
| `service_headers_invalid` | A header in `options.headers` is one HTTP itself controls (`content-length`, `host`, `connection` and the like), or its name or value cannot go on a header line. |
| `host_not_public`         | The host does not resolve to a public IP address.                                                           |

**The call is allowed but cannot go through right now.** Some of these clear
on their own.

| `code`               | What it means                                                                          |
| -------------------- | -------------------------------------------------------------------------------------- |
| `cap_exceeded`       | A cap has been reached. Try again later.                                               |
| `rate_limited`       | Over Brass's own rate limit. The SDK resends a call that limit turns away for only a moment, so wait before calling again. |
| `calls_paused`       | Whoever owns the account being spent set its cap to zero. Waiting will not clear it.   |
| `vault_unavailable`  | Brass could not read the stored key just now. Nothing is wrong with it; make the same call again. |

**Brass could not return the response.**

| `code`               | What it means                                                       |
| -------------------- | --------------------------------------------------------------------- |
| `response_too_large` | The service returned more than 5 MB.                                  |
| `response_not_text`  | The service returned bytes rather than text. Call an endpoint that returns a URL or base64. |
| `response_unreadable`| Brass could not read the service's response.                          |
| `response_redirected`| The service answered with a redirect. The body carries its `location`. |
| `service_timeout`    | The service did not answer in time.                                   |
| `service_unreachable`| Brass could not reach the service.                                    |

**The app is not the one that may call.** These are about your app's standing
rather than the credential.

| `code`               | What it means                                                       |
| -------------------- | --------------------------------------------------------------------- |
| `app_not_installed`  | The organization has not installed your app. `requestMissingCredentials: true` raises the install dialog; otherwise the call returns `403`. |
| `no_acting_app`      | The caller is not acting as an app. |

A call made before the app has an organization returns `409 destination_required`.

## Asking for a missing credential

`Brass.listServices()` returns each declared host, with `ready: true` where
Brass has a credential for it. It shows no dialog, so you can call it while
the page loads. It returns `null` while the app is acting nowhere: nobody is
signed in, the app has no organization, or it is running in one that has not
installed it.

Each entry also carries `connectable`, which says whether the dialog has
anything for the user on the page to do at that host. Together the two are
the whole branch:

```js
const services = await Brass.listServices();
const ai = services?.find((s) => s.host === 'api.anthropic.com');
if (ai?.ready) showSummariseButton();
else if (ai?.connectable) showConnectCard();
else showUnavailableCard();
```

`Brass.connectService(host)` opens the dialog and resolves true once that
host works. Whoever can supply the credential does it there; anyone else is
told who to ask. Put it on a button, so the user is asked when they reach for
the feature:

```js
if (await Brass.connectService('api.anthropic.com')) showSummariseButton();
```

Passing `requestMissingCredentials: true` to `callService` opens the same
dialog from the call, which then goes through once the user answers. It covers
every refusal your app's user can answer: `credential_required`, plus
`credential_rejected` and `credential_scheme_unusable` when the account that
failed is one they own.

A host still waiting for the key you enter as its author
(`app_credential_not_set`, `app_credential_incomplete`) is yours to settle on
the app's own settings page, so the call returns that refusal for you to
handle:

```js
const res = await Brass.callService(host, path, { requestMissingCredentials: true });
```

## Who supplies the credential

You choose on your app's settings page whether a host runs on a key of yours
or on an account whoever runs your app connects, and they can change that
under you. A host you have just declared starts on a key of yours, so
`connectable` is false there until you change it. Either way your call is the
same one: you name a host, and Brass attaches whichever credential is in
force.

Your app reads `connectable` rather than the supplier, because that is the
split it can act on. Where it is true, your app's user can
settle it, so a Connect button leads somewhere; where it is false, the host is
waiting on you, so there is nothing to raise. Leave the wording about who to
ask to the dialog, which knows both the supplier and who is reading, where
your app is told neither.

## Values the app reads

Your app sometimes has to include a value in the request it sends, such as
an account id. Mark that field `readable` in the manifest and Brass returns
it to your app with the service.

Brass collects the value when somebody connects an account, and offers your app
only the accounts carrying it, so it is there whenever a call reaches your code.

The field's name is the key your app reads the value back under.

```json
{
  "services": [
    {
      "host": "api.cloudflare.com",
      "headers": { "authorization": "Bearer {token}" },
      "fields": [{ "name": "account_id", "readable": true, "label": "Account ID" }]
    }
  ]
}
```

```js
const services = await Brass.listServices();
const cf = services?.find((s) => s.host === 'api.cloudflare.com');
const account = cf?.values?.account_id;
if (cf?.ready && account) {
  const res = await Brass.callService(
    'api.cloudflare.com',
    `client/v4/accounts/${account}/tokens/verify`,
    { method: 'GET' },
  );
}
```

`values` is present on a `ready` service.

## Providing credential setup instructions

Brass shows your setup instructions on the form that collects a credential,
and you are strongly encouraged to provide them. Without them the form shows
your field labels alone, and the user filling it in has to work out what
to create at the vendor and where.

Declare a `setup` beside the host:

```json
{
  "services": [
    {
      "host": "api.example.com",
      "headers": { "authorization": "Bearer {secret}" },
      "setup": {
        "credentialName": "API key",
        "consoleUrl": "https://example.com/settings/keys",
        "docsUrl": "https://example.com/docs/api",
        "steps": [
          "Open Settings, then API keys.",
          "Create a key with read and write access.",
          "Copy the key before closing the dialog."
        ]
      }
    }
  ]
}
```

- **`credentialName`** is what the vendor calls the credential, so it
  matches what they see there.
- **`consoleUrl`** is the page where they create it. Link to that page
  rather than the vendor's home page.
- **`docsUrl`** is where the vendor documents this method.
- **`steps`** are step-by-step instructions for creating the credential.
  Up to six, shown in order.

## A service split across addresses

A wildcard host (`*.myshopify.com`) covers every address under it;
[`app-manifest.md`](./app-manifest.md) covers declaring one. Which `host` you
pass to `callService` depends on `credentialPerHost`.

Without it, one credential covers every address under the suffix, and
`listServices` returns a single entry under the declared name. Match on the
wildcard, not on the address you are about to call.

With it, each secret is entered against a specific address, and
`listServices` returns one entry per connected address, each with
`declared_as: '*.myshopify.com'`. Pass the `host` from one of those entries.
An address you build from a shop name points at a shop nobody has connected.
Before any address is connected there is one entry for the wildcard itself,
and `Brass.connectService` takes that `host`:

```js
const shops = ((await Brass.listServices()) ?? []).filter(
  (s) => s.declared_as === '*.myshopify.com',
);
const connected = shops.filter((s) => s.ready);
if (connected.length === 0) await Brass.connectService('*.myshopify.com');
```
