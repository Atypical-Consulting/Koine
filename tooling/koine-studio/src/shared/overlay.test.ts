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
