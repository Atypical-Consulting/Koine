import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { AssistantView, ASSISTANT_MOUNT_CLASS } from './AssistantView';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AssistantView', () => {
  it('renders a single mount node the host can attach the imperative panel to', () => {
    const { container } = render(<AssistantView />);
    const mounts = container.querySelectorAll(`.${ASSISTANT_MOUNT_CLASS}`);
    expect(mounts).toHaveLength(1);
    // Empty in production — the host populates it; the component must not pre-fill it.
    expect(mounts[0].childElementCount).toBe(0);
  });

  it('composes children inside the mount node (the seam stories/tests use for representative content)', () => {
    const { container } = render(
      <AssistantView>
        <p class="koi-assistant-intro">Ask the assistant about your model.</p>
      </AssistantView>,
    );
    const mount = container.querySelector(`.${ASSISTANT_MOUNT_CLASS}`)!;
    expect(mount.querySelector('.koi-assistant-intro')?.textContent).toContain('Ask the assistant');
  });

  it('has no axe violations with representative assistant content', async () => {
    const { container } = render(
      <AssistantView>
        <div class="koi-assistant">
          <div class="koi-assistant-transcript">
            <p class="koi-assistant-intro">Ask the assistant about your model.</p>
          </div>
        </div>
      </AssistantView>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
