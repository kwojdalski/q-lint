# Add a process

A process is a label, a host and a port, and optionally:

- **TLS**: yes when the process was started with `-E 1` or `-E 2`.
- **Authentication**: a user, then that user's password. The password is kept
  in VS Code's SecretStorage, never in settings or in an export.
- **Tags**, such as `prod`, `uat` or `dev`, which group the Processes view and
  colour it. **Edit Tag Color** on a tag row colours any other tag.

To try it, start a q on your machine and add it as `localhost` and its port:

```sh
q -p 5000
```

q-lint connects only to a process you add, and sends only the code you run.
