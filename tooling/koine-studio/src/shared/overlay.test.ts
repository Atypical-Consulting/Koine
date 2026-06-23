import { afterEach, describe, expect, test } from "vitest";
import { createModal } from "@/shared/overlay";

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
