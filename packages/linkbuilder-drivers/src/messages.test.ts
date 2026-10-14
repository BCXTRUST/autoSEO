import { describe, expect, it } from "vitest";
import {
  adminActivationNotice,
  adminHoldOnVerify,
  captchaRejected,
  classifyRegistration,
  formErrorFixable,
  postAwaitingAdmin,
  splitFormContinues,
  usernameFormatRejected,
} from "./messages.js";

describe("registration notices", () => {
  it("treats a refused captcha as retryable, not as a board refusal", () => {
    const refused = [
      "Die von Ihnen eingegebene Antwort ist falsch",
      "The solution you provided was incorrect.",
      "The confirmation code you entered was incorrect.",
      "Der Bestätigungscode, den du eingegeben hast, war falsch.",
      "You have provided an invalid answer to the question.",
      "Du hast die Frage falsch beantwortet.",
      "Du hast eine falsche Antwort auf die Frage angegeben.",
      "The CAPTCHA verification failed. Please try again.",
      "Die Sicherheitsabfrage war ungültig.",
    ];
    for (const text of refused) {
      expect(captchaRejected(text), text).toBe(true);
      expect(classifyRegistration(text, true)).toEqual({ kind: "captcha_rejected" });
    }
  });

  it("leaves ordinary form errors alone", () => {
    for (const text of [
      "The username you entered is already in use.",
      "Der Benutzername ist bereits vergeben.",
      "Das Passwort muss zwischen 6 und 100 Zeichen lang sein.",
      "Bitte geben Sie eine gültige E-Mail-Adresse ein.",
    ]) {
      expect(captchaRejected(text), text).toBe(false);
      expect(classifyRegistration(text, true).kind).toBe("form_error");
    }
  });

  it("classifies the registration answers the generic flow retries or stops on", () => {
    expect(classifyRegistration("Please enter your birthday.", true).kind).toBe("form_error");
    expect(formErrorFixable(["Please enter your birthday."])).toBe(true);
    expect(formErrorFixable(["The username you entered is already in use."])).toBe(true);
    expect(
      usernameFormatRejected([
        "Bitte gib einen anderen Namen ein. Der eingegebene Wert stimmt nicht mit dem gewünschten Format überein.",
      ]),
    ).toBe(true);
    expect(
      classifyRegistration(
        "An activation key has been sent to the email address you provided.",
        false,
      ).kind,
    ).toBe("pending_email");
    expect(
      classifyRegistration(
        "Danke. Eine E-Mail wurde an sophie@inbox.example gesendet. Bitte klicke auf den Link.",
        true,
      ).kind,
    ).toBe("pending_email");
    expect(
      classifyRegistration(
        "Vielen Dank für deine Anmeldung. Um deine Registrierung abzuschließen, musst du dem Link in der E-Mail folgen, die dir zugesandt wurde.",
        false,
      ).kind,
    ).toBe("pending_email");
    expect(
      classifyRegistration(
        "An administrator will activate your account before you can log in.",
        false,
      ).kind,
    ).toBe("pending_admin");
    expect(
      classifyRegistration("Probleme mit dem Mail-Client? Win11 aktiviert aber Update.", false)
        .kind,
    ).not.toBe("pending_email");
    expect(classifyRegistration("Your account has now been activated.", false).kind).toBe("active");
    expect(
      classifyRegistration(
        "Information Dein Benutzerkonto wurde erstellt. Es muss jedoch erst durch einen Administrator freigeschaltet werden. Die Administratoren wurden per E-Mail informiert.",
        true,
      ).kind,
    ).toBe("pending_admin");
    expect(
      classifyRegistration(
        "Dein Benutzerkonto wartet derzeit auf eine Bestätigung durch einen Administrator. Je nach Anwesenheit der Moderatoren kann die Konto-Freischaltung einige Minuten dauern.",
        false,
      ).kind,
    ).toBe("pending_admin");
    expect(
      adminActivationNotice(
        "Dein Benutzerkonto wurde erstellt. Es muss jedoch erst durch einen Administrator freigeschaltet werden.",
      ),
    ).toBe(true);
    expect(
      adminActivationNotice("An administrator must activate your account before you can log in."),
    ).toBe(true);
    expect(adminActivationNotice("An activation key has been sent to your email.")).toBe(false);
    expect(postAwaitingAdmin("Your post is awaiting moderation.")).toBe(true);
    expect(postAwaitingAdmin("Dieser Beitrag wartet auf die Freigabe eines Moderators.")).toBe(
      true,
    );
    expect(
      postAwaitingAdmin(
        "Dein Benutzerkonto wurde erstellt. Es muss jedoch erst durch einen Administrator freigeschaltet werden.",
      ),
    ).toBe(false);
    expect(adminHoldOnVerify("Your reply is awaiting approval.")).toBe("post");
    expect(
      adminHoldOnVerify("An administrator must activate your account before you can log in."),
    ).toBe("registration");
    expect(adminHoldOnVerify("Topic not found")).toBeNull();
  });

  it("continues a split signup when the next step has no error", () => {
    expect(splitFormContinues({ kind: "form_error", messages: [] })).toBe(true);
    expect(splitFormContinues({ kind: "form_error", messages: ["Step 2"] })).toBe(true);
    expect(splitFormContinues({ kind: "form_error", messages: ["Schritt 2"] })).toBe(true);
    expect(
      splitFormContinues({
        kind: "form_error",
        messages: ["The username you entered is already in use."],
      }),
    ).toBe(false);
    expect(splitFormContinues({ kind: "pending_email" })).toBe(false);
  });
});
