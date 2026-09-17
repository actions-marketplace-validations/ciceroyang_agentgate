import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { alertEnv, netrcText, sendAlert } from "../src/alert.mjs"

const CONFIG = { host: "smtp.example.invalid", port: 465, user: "u@example.com", pass: "s3cr3t-value", from: "u@example.com", to: "me@example.com" }

test("a missing variable is named, and only its name is ever printed", function () {
  try {
    alertEnv({ SMTP_HOST: "h" })
    assert.fail("should have thrown")
  } catch (error) {
    assert.match(error.message, /SMTP_PORT/)
    assert.match(error.message, /AGENTGATE_ALERT_TO/)
    assert.equal(error.message.indexOf("s3cr3t"), -1)
  }
})

test("a port that is not a port is refused", function () {
  assert.throws(function () {
    alertEnv({ SMTP_HOST: "h", SMTP_PORT: "not-a-port", SMTP_USER: "u", SMTP_PASS: "p", AGENTGATE_ALERT_TO: "to@example.com" })
  }, /SMTP_PORT/)
})

test("the sender defaults to the authenticated user", function () {
  const config = alertEnv({ SMTP_HOST: "h", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p", AGENTGATE_ALERT_TO: "to@example.com" })
  assert.equal(config.from, "u")
  assert.equal(config.port, 465)
  assert.equal(config.to, "to@example.com")
})

test("credentials go into a netrc file, never into the argument list", function () {
  const seen = {}
  const result = sendAlert("From: a\n\nbody\n", {
    config: CONFIG,
    runner: function (command, args, settings) {
      seen.command = command
      const netrcIndex = args.indexOf("--netrc-file")
      seen.netrcPath = args[netrcIndex + 1]
      seen.args = args
      seen.input = settings.input
      seen.netrc = readFileSync(seen.netrcPath, "utf8")
      return { status: 0, stderr: "" }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(seen.command, "curl")
  assert.equal(seen.args.join(" ").indexOf(CONFIG.pass), -1, "the password must not be an argument")
  assert.equal(seen.netrc.indexOf(CONFIG.pass) !== -1, true, "the password belongs in the file")
  assert.equal(seen.input.indexOf("body") !== -1, true)
  assert.equal(existsSync(seen.netrcPath), false, "the credential file is removed afterwards")
})

test("a failed curl is reported with its first error line and no secret", function () {
  const result = sendAlert("x", {
    config: CONFIG,
    runner: function () { return { status: 67, stderr: "curl: (67) Access denied\nmore" } },
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /Access denied/)
  assert.equal(result.detail.indexOf(CONFIG.pass), -1)
})

test("the netrc line is the one curl expects", function () {
  assert.equal(netrcText(CONFIG), "machine smtp.example.invalid login u@example.com password s3cr3t-value\n")
})
