import { afterEach, describe, expect, test } from "vitest";
import { createModal, createPromptDialog } from "./overlay";

// Each test builds a fresh modal mounted on document.body; clear it between tests so
// stale backdrops/handlers don't leak across cases.
afterEach(() => {
  document.body.innerHTML = "";
});

function tab(target: Element, shiftKey = false): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
  );
}

describe("createModal chrome", () => {
  test("builds the dialog structure with role/aria, header, body and footer", () => {
    const { backdrop, body } = createModal({ title: "Preferences", variant: "koi-modal-wide" });

    expect(backdrop.className).toBe("koi-modal-backdrop");
    expect(backdrop.hidden).toBe(true);

    const modal = backdrop.querySelector(".koi-modal")!;
    expect(modal.classList.contains("koi-modal-wide")).toBe(true);
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.getAttribute("aria-label")).toBe("Preferences"); // defaults to the title

    expect(modal.querySelector(".koi-modal-title")!.textContent).toBe("Preferences");
    expect(body.className).toBe("koi-modal-body");
    expect(backdrop.querySelector(".koi-modal-footer")).not.toBeNull();

    const closeBtn = backdrop.querySelector<HTMLButtonElement>(".koi-modal-close")!;
    expect(closeBtn.type).toBe("button");
    expect(closeBtn.getAttribute("aria-label")).toBe("Close");
    expect(closeBtn.textContent).toBe("✕");
  });

  test("aria-label can be overridden independently of the visible title", () => {
    const { backdrop } = createModal({ title: "About", ariaLabel: "About Koine Studio" });
    expect(backdrop.querySelector(".koi-modal")!.getAttribute("aria-label")).toBe("About Koine Studio");
    expect(backdrop.querySelector(".koi-modal-title")!.textContent).toBe("About");
  });
});

describe("createModal focus trap", () => {
  test("Tab from the last focusable element wraps to the first", () => {
    const modalHandle = createModal({ title: "Trap me" });
    const first = document.createElement("button");
    first.textContent = "first";
    const last = document.createElement("button");
    last.textContent = "last";
    modalHandle.body.append(first, last);

    modalHandle.open();

    last.focus();
    expect(document.activeElement).toBe(last);

    tab(last);

    // The header close button is the very first focusable element in the modal.
    const closeBtn = modalHandle.backdrop.querySelector<HTMLElement>(".koi-modal-close");
    expect(document.activeElement).toBe(closeBtn);
  });

  test("Shift+Tab from the first focusable element wraps to the last", () => {
    const modalHandle = createModal({ title: "Trap me" });
    const last = document.createElement("button");
    last.textContent = "last";
    modalHandle.body.append(last);

    modalHandle.open();

    const closeBtn = modalHandle.backdrop.querySelector<HTMLElement>(".koi-modal-close")!;
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    tab(closeBtn, true);

    expect(document.activeElement).toBe(last);
  });
});

describe("createPromptDialog", () => {
  // Only one prompt is mounted at a time (afterEach clears the body), so these unscoped queries are safe.
  const fields = () => ({
    input: document.querySelector<HTMLInputElement>(".koi-prompt-input")!,
    label: document.querySelector<HTMLElement>(".koi-prompt-label")!,
    error: document.querySelector<HTMLElement>(".koi-prompt-error")!,
    ok: document.querySelector<HTMLButtonElement>(".koi-confirm-btn-primary")!,
    cancel: document.querySelector<HTMLButtonElement>(".koi-confirm-btn:not(.koi-confirm-btn-primary)")!,
  });

  test("opens with the field focused and OK disabled when empty", () => {
    void createPromptDialog().ask({ title: "New entity", label: "Name", confirmLabel: "Create" });
    const { input, label, ok } = fields();
    expect(label.textContent).toBe("Name");
    expect(ok.textContent).toBe("Create");
    expect(ok.disabled).toBe(true); // nothing typed yet → no value to commit
    expect(document.activeElement).toBe(input);
  });

  test("resolves the trimmed value when OK is clicked", async () => {
    const p = createPromptDialog().ask({ title: "New entity", initialValue: "Order" });
    const { input, ok } = fields();
    expect(ok.disabled).toBe(false); // pre-filled → enabled
    input.value = "  PurchaseOrder  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    ok.click();
    await expect(p).resolves.toBe("PurchaseOrder");
  });

  test("Enter in the field submits", async () => {
    const p = createPromptDialog().ask({ title: "New entity", initialValue: "Order" });
    fields().input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await expect(p).resolves.toBe("Order");
  });

  test("a failing validator blocks submit and surfaces the error inline", async () => {
    const p = createPromptDialog().ask({
      title: "New entity",
      initialValue: "9bad",
      validate: (v) => (/^[A-Za-z]/.test(v) ? null : "Start with a letter."),
    });
    const { input, ok, error } = fields();
    expect(ok.disabled).toBe(true); // live-invalid initial value
    expect(error.textContent).toBe("Start with a letter.");
    expect(input.classList.contains("is-invalid")).toBe(true);

    input.value = "Good"; // fix it
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ok.disabled).toBe(false);
    expect(error.textContent).toBe("");
    ok.click();
    await expect(p).resolves.toBe("Good");
  });

  test("seeds an inline error from the request (the duplicate-name case, no second alert)", () => {
    void createPromptDialog().ask({
      title: "Save project",
      initialValue: "demo",
      error: 'A project named "demo" already exists — choose another name.',
    });
    const { input, error } = fields();
    expect(error.textContent).toContain("already exists");
    expect(input.classList.contains("is-invalid")).toBe(true);
  });

  test("cancel resolves null", async () => {
    const p = createPromptDialog().ask({ title: "New entity", initialValue: "Order" });
    fields().cancel.click();
    await expect(p).resolves.toBeNull();
  });
});
