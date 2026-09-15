# How the action was verified

This directory exists so the action can be run against a project that breaks its own
policy. Everything in it is intentional: an unpinned `npx` runner and a filesystem root,
both forbidden by the policy next to it.

`action-verify.yml` runs the action on pull requests. A pull request that changes this
directory should go red with the two rules named in the report and a comment on the pull
request. That is the evidence that the action gates rather than merely parses.
