/**
 * Writes a reply into a WoltLab CKEditor when the visible editor, not the hidden
 * textarea, is what the save button submits.
 */
export async function writeWysiwygText(payload: {
  selector: string;
  text: string;
}): Promise<"wrote" | "plain" | "missing"> {
  const scope = globalThis as {
    document?: { querySelector(selector: string): WysiwygNode | null };
    require?: (
      deps: string[],
      done: (mod: {
        getCkeditor?: (node: WysiwygNode) => { setHtml?: (html: string, focus?: boolean) => void };
      }) => void,
    ) => void;
  };
  const node = scope.document?.querySelector(payload.selector) ?? null;
  if (!node) return "plain";
  const tag = (node.tagName ?? "").toUpperCase();
  const classes = typeof node.className === "string" ? node.className.split(/\s+/) : [];
  if (tag !== "TEXTAREA" || !classes.includes("wysiwygTextarea")) return "plain";
  if (typeof scope.require !== "function") return "missing";
  const html = wysiwygHtml(payload.text);
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: "wrote" | "missing") => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      scope.require!(["WoltLabSuite/Core/Component/Ckeditor"], (mod) => {
        try {
          const editor = mod?.getCkeditor?.(node);
          if (!editor || typeof editor.setHtml !== "function") {
            finish("missing");
            return;
          }
          editor.setHtml(html, false);
          finish("wrote");
        } catch {
          finish("missing");
        }
      });
    } catch {
      finish("missing");
    }
  });
}

export function wysiwygHtml(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const parts = blocks.length > 0 ? blocks : [text];
  return parts.map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface WysiwygNode {
  tagName?: string;
  className?: string;
}
