import { describe, expect, it } from "vitest";
import {
  isLegacyAgentMailbox,
  mailboxAddressesToRead,
  personMailboxAddress,
  signupMailboxAddress,
} from "./person-mailbox.js";

describe("person mailbox", () => {
  it("looks like a person on the Resend domain and stays stable", () => {
    const address = personMailboxAddress("project-1:0", "sideinbox.email");
    expect(address).toMatch(/^[a-z]+\.[a-z]+@sideinbox\.email$/);
    expect(address.startsWith("lb-")).toBe(false);
    expect(personMailboxAddress("project-1:0", "Sideinbox.email")).toBe(address);
    expect(personMailboxAddress("project-2:0", "sideinbox.email")).not.toBe(address);
  });

  it("treats AgentMail and lb- local parts as legacy", () => {
    expect(isLegacyAgentMailbox("lb-cmuwjtyeg00005xo5zgz70ls2@agentmail.to")).toBe(true);
    expect(isLegacyAgentMailbox("lb-project@sideinbox.email")).toBe(true);
    expect(isLegacyAgentMailbox("lena.hoffmann@sideinbox.email")).toBe(false);
  });

  it("uses a person address for a new signup and keeps an existing inbox", () => {
    const created = signupMailboxAddress({
      existingAccount: false,
      storedAddress: "lb-cmuwjtyeg00005xo5zgz70ls2@agentmail.to",
      seed: "project-1",
      domain: "sideinbox.email",
      priorSignups: 0,
    });
    expect(created).toMatch(/^[a-z]+\.[a-z]+@sideinbox\.email$/);
    expect(
      signupMailboxAddress({
        existingAccount: true,
        storedAddress: "lena.hoffmann@sideinbox.email",
        seed: "project-1",
        domain: "sideinbox.email",
        priorSignups: 4,
      }),
    ).toBe("lena.hoffmann@sideinbox.email");
    expect(
      signupMailboxAddress({
        existingAccount: true,
        storedAddress: "lb-cmuwjtyeg00005xo5zgz70ls2@sideinbox.email",
        seed: "project-1",
        domain: "sideinbox.email",
        priorSignups: 4,
      }),
    ).toMatch(/^[a-z]+\.[a-z]+@sideinbox\.email$/);
  });

  it("keeps reading older person addresses and the stored AgentMail inbox", () => {
    const first = personMailboxAddress("project-1:0", "sideinbox.email");
    const next = personMailboxAddress("project-1:1", "sideinbox.email");
    expect(
      mailboxAddressesToRead({
        seed: "project-1",
        domain: "sideinbox.email",
        priorSignups: 10,
        storedIds: ["lb-old@agentmail.to", first],
      }),
    ).toEqual(["lb-old@agentmail.to", first, next]);
  });
});
