// Thin Preact→React adapter.
//
// The claude.ai/design runtime renders with REACT. Koine Studio's components are PREACT. This wraps a
// Preact component in a React component so `window.KoineStudio.<Name>` is React-mountable: the wrapper is
// a real React function component (using the runtime's window.React), and inside a layout effect it renders
// the Preact tree into a container the React wrapper owns.
//
// Cross-boundary composition: a React design may pass `children` (React elements) into an adapted
// component. Preact can't render React vnodes, so children are bridged — React renders them into a detached
// DOM host, and that host is spliced into the Preact tree as a plain element. Slots therefore work in both
// directions.
import { h as preactH, render as preactRender } from 'preact';

const React = window.React;
const ReactDOM = window.ReactDOM;

export function adapt(PreactComponent, displayName) {
  function Adapted(props) {
    const containerRef = React.useRef(null);
    const childBridge = React.useRef(null); // { host, root } lazily created when children exist

    // (re)render the Preact tree on every commit — props are cheap, and always-render keeps the two
    // reconcilers in sync without a bespoke equality check.
    React.useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const { children, ...rest } = props;

      let preactChildren;
      if (children != null && children !== false) {
        if (!childBridge.current) {
          const host = document.createElement('div');
          host.style.display = 'contents';
          childBridge.current = { host, root: ReactDOM.createRoot(host) };
        }
        childBridge.current.root.render(children);
        const host = childBridge.current.host;
        // a Preact vnode that re-parents the React-owned host into the Preact tree
        preactChildren = preactH('div', {
          style: 'display:contents',
          ref: (el) => {
            if (el && host.parentNode !== el) el.appendChild(host);
          },
        });
      }

      preactRender(preactH(PreactComponent, rest, preactChildren), container);
    });

    // teardown both reconcilers on unmount
    React.useEffect(
      () => () => {
        if (containerRef.current) preactRender(null, containerRef.current);
        if (childBridge.current) childBridge.current.root.unmount();
      },
      [],
    );

    return React.createElement('div', { ref: containerRef, style: { display: 'contents' } });
  }
  Adapted.displayName = displayName;
  return Adapted;
}
