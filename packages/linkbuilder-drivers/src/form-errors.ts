import { load } from "cheerio";

const ERROR_SELECTOR =
  ".error, .errorField, .innerError, .formError, .alert-danger, [role=alert], .blockErrors";

/** Visible refusal text. Empty pages fall back to a stable reason so statusReason is never blank. */
export function formErrorTextFromHtml(html: string): string {
  const $ = load(html);
  const parts: string[] = [];
  $(ERROR_SELECTOR).each((_, node) => {
    const text = $(node).text().replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
  });
  $("input[aria-invalid='true'], textarea[aria-invalid='true'], .invalid").each((_, node) => {
    const field = $(node);
    const id = field.attr("id");
    const label = id ? $(`label[for='${id}']`).text() : "";
    const near = [label, field.attr("placeholder") ?? "", field.parent().text()]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (near) parts.push(near);
  });
  const text = [...new Set(parts)].join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
  return text || "form_error:no_text";
}
