"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/model/SourceControlPanel.stories.tsx
  var SourceControlPanel_stories_exports = {};
  __export(SourceControlPanel_stories_exports, {
    BrowserDesktopOnly: () => BrowserDesktopOnly,
    CleanTree: () => CleanTree,
    Desktop: () => Desktop,
    NotARepository: () => NotARepository,
    default: () => SourceControlPanel_stories_default
  });

  // node_modules/preact/dist/preact.module.js
  var n;
  var l;
  var u;
  var t;
  var i;
  var r;
  var o;
  var e;
  var f;
  var c;
  var a;
  var s;
  var h;
  var p;
  var v;
  var y;
  var d = {};
  var w = [];
  var _ = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
  var g = Array.isArray;
  function m(n2, l3) {
    for (var u4 in l3) n2[u4] = l3[u4];
    return n2;
  }
  function b(n2) {
    n2 && n2.parentNode && n2.parentNode.removeChild(n2);
  }
  function k(l3, u4, t3) {
    var i3, r3, o3, e3 = {};
    for (o3 in u4) "key" == o3 ? i3 = u4[o3] : "ref" == o3 ? r3 = u4[o3] : e3[o3] = u4[o3];
    if (arguments.length > 2 && (e3.children = arguments.length > 3 ? n.call(arguments, 2) : t3), "function" == typeof l3 && null != l3.defaultProps) for (o3 in l3.defaultProps) void 0 === e3[o3] && (e3[o3] = l3.defaultProps[o3]);
    return x(l3, e3, i3, r3, null);
  }
  function x(n2, t3, i3, r3, o3) {
    var e3 = { type: n2, props: t3, key: i3, ref: r3, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: null == o3 ? ++u : o3, __i: -1, __u: 0 };
    return null == o3 && null != l.vnode && l.vnode(e3), e3;
  }
  function S(n2) {
    return n2.children;
  }
  function C(n2, l3) {
    this.props = n2, this.context = l3;
  }
  function $(n2, l3) {
    if (null == l3) return n2.__ ? $(n2.__, n2.__i + 1) : null;
    for (var u4; l3 < n2.__k.length; l3++) if (null != (u4 = n2.__k[l3]) && null != u4.__e) return u4.__e;
    return "function" == typeof n2.type ? $(n2) : null;
  }
  function I(n2) {
    if (n2.__P && n2.__d) {
      var u4 = n2.__v, t3 = u4.__e, i3 = [], r3 = [], o3 = m({}, u4);
      o3.__v = u4.__v + 1, l.vnode && l.vnode(o3), q(n2.__P, o3, u4, n2.__n, n2.__P.namespaceURI, 32 & u4.__u ? [t3] : null, i3, null == t3 ? $(u4) : t3, !!(32 & u4.__u), r3), o3.__v = u4.__v, o3.__.__k[o3.__i] = o3, D(i3, o3, r3), u4.__e = u4.__ = null, o3.__e != t3 && P(o3);
    }
  }
  function P(n2) {
    if (null != (n2 = n2.__) && null != n2.__c) return n2.__e = n2.__c.base = null, n2.__k.some(function(l3) {
      if (null != l3 && null != l3.__e) return n2.__e = n2.__c.base = l3.__e;
    }), P(n2);
  }
  function A(n2) {
    (!n2.__d && (n2.__d = true) && i.push(n2) && !H.__r++ || r != l.debounceRendering) && ((r = l.debounceRendering) || o)(H);
  }
  function H() {
    try {
      for (var n2, l3 = 1; i.length; ) i.length > l3 && i.sort(e), n2 = i.shift(), l3 = i.length, I(n2);
    } finally {
      i.length = H.__r = 0;
    }
  }
  function L(n2, l3, u4, t3, i3, r3, o3, e3, f4, c3, a3) {
    var s3, h3, p3, v3, y3, _2, g2, m3 = t3 && t3.__k || w, b2 = l3.length;
    for (f4 = T(u4, l3, m3, f4, b2), s3 = 0; s3 < b2; s3++) null != (p3 = u4.__k[s3]) && (h3 = -1 != p3.__i && m3[p3.__i] || d, p3.__i = s3, _2 = q(n2, p3, h3, i3, r3, o3, e3, f4, c3, a3), v3 = p3.__e, p3.ref && h3.ref != p3.ref && (h3.ref && J(h3.ref, null, p3), a3.push(p3.ref, p3.__c || v3, p3)), null == y3 && null != v3 && (y3 = v3), (g2 = !!(4 & p3.__u)) || h3.__k === p3.__k ? (f4 = j(p3, f4, n2, g2), g2 && h3.__e && (h3.__e = null)) : "function" == typeof p3.type && void 0 !== _2 ? f4 = _2 : v3 && (f4 = v3.nextSibling), p3.__u &= -7);
    return u4.__e = y3, f4;
  }
  function T(n2, l3, u4, t3, i3) {
    var r3, o3, e3, f4, c3, a3 = u4.length, s3 = a3, h3 = 0;
    for (n2.__k = new Array(i3), r3 = 0; r3 < i3; r3++) null != (o3 = l3[r3]) && "boolean" != typeof o3 && "function" != typeof o3 ? ("string" == typeof o3 || "number" == typeof o3 || "bigint" == typeof o3 || o3.constructor == String ? o3 = n2.__k[r3] = x(null, o3, null, null, null) : g(o3) ? o3 = n2.__k[r3] = x(S, { children: o3 }, null, null, null) : void 0 === o3.constructor && o3.__b > 0 ? o3 = n2.__k[r3] = x(o3.type, o3.props, o3.key, o3.ref ? o3.ref : null, o3.__v) : n2.__k[r3] = o3, f4 = r3 + h3, o3.__ = n2, o3.__b = n2.__b + 1, e3 = null, -1 != (c3 = o3.__i = O(o3, u4, f4, s3)) && (s3--, (e3 = u4[c3]) && (e3.__u |= 2)), null == e3 || null == e3.__v ? (-1 == c3 && (i3 > a3 ? h3-- : i3 < a3 && h3++), "function" != typeof o3.type && (o3.__u |= 4)) : c3 != f4 && (c3 == f4 - 1 ? h3-- : c3 == f4 + 1 ? h3++ : (c3 > f4 ? h3-- : h3++, o3.__u |= 4))) : n2.__k[r3] = null;
    if (s3) for (r3 = 0; r3 < a3; r3++) null != (e3 = u4[r3]) && 0 == (2 & e3.__u) && (e3.__e == t3 && (t3 = $(e3)), K(e3, e3));
    return t3;
  }
  function j(n2, l3, u4, t3) {
    var i3, r3;
    if ("function" == typeof n2.type) {
      for (i3 = n2.__k, r3 = 0; i3 && r3 < i3.length; r3++) i3[r3] && (i3[r3].__ = n2, l3 = j(i3[r3], l3, u4, t3));
      return l3;
    }
    n2.__e != l3 && (t3 && (l3 && n2.type && !l3.parentNode && (l3 = $(n2)), u4.insertBefore(n2.__e, l3 || null)), l3 = n2.__e);
    do {
      l3 = l3 && l3.nextSibling;
    } while (null != l3 && 8 == l3.nodeType);
    return l3;
  }
  function O(n2, l3, u4, t3) {
    var i3, r3, o3, e3 = n2.key, f4 = n2.type, c3 = l3[u4], a3 = null != c3 && 0 == (2 & c3.__u);
    if (null === c3 && null == e3 || a3 && e3 == c3.key && f4 == c3.type) return u4;
    if (t3 > (a3 ? 1 : 0)) {
      for (i3 = u4 - 1, r3 = u4 + 1; i3 >= 0 || r3 < l3.length; ) if (null != (c3 = l3[o3 = i3 >= 0 ? i3-- : r3++]) && 0 == (2 & c3.__u) && e3 == c3.key && f4 == c3.type) return o3;
    }
    return -1;
  }
  function z(n2, l3, u4) {
    "-" == l3[0] ? n2.setProperty(l3, null == u4 ? "" : u4) : n2[l3] = null == u4 ? "" : "number" != typeof u4 || _.test(l3) ? u4 : u4 + "px";
  }
  function N(n2, l3, u4, t3, i3) {
    var r3, o3;
    n: if ("style" == l3) if ("string" == typeof u4) n2.style.cssText = u4;
    else {
      if ("string" == typeof t3 && (n2.style.cssText = t3 = ""), t3) for (l3 in t3) u4 && l3 in u4 || z(n2.style, l3, "");
      if (u4) for (l3 in u4) t3 && u4[l3] == t3[l3] || z(n2.style, l3, u4[l3]);
    }
    else if ("o" == l3[0] && "n" == l3[1]) r3 = l3 != (l3 = l3.replace(s, "$1")), o3 = l3.toLowerCase(), l3 = o3 in n2 || "onFocusOut" == l3 || "onFocusIn" == l3 ? o3.slice(2) : l3.slice(2), n2.l || (n2.l = {}), n2.l[l3 + r3] = u4, u4 ? t3 ? u4[a] = t3[a] : (u4[a] = h, n2.addEventListener(l3, r3 ? v : p, r3)) : n2.removeEventListener(l3, r3 ? v : p, r3);
    else {
      if ("http://www.w3.org/2000/svg" == i3) l3 = l3.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
      else if ("width" != l3 && "height" != l3 && "href" != l3 && "list" != l3 && "form" != l3 && "tabIndex" != l3 && "download" != l3 && "rowSpan" != l3 && "colSpan" != l3 && "role" != l3 && "popover" != l3 && l3 in n2) try {
        n2[l3] = null == u4 ? "" : u4;
        break n;
      } catch (n3) {
      }
      "function" == typeof u4 || (null == u4 || false === u4 && "-" != l3[4] ? n2.removeAttribute(l3) : n2.setAttribute(l3, "popover" == l3 && 1 == u4 ? "" : u4));
    }
  }
  function V(n2) {
    return function(u4) {
      if (this.l) {
        var t3 = this.l[u4.type + n2];
        if (null == u4[c]) u4[c] = h++;
        else if (u4[c] < t3[a]) return;
        return t3(l.event ? l.event(u4) : u4);
      }
    };
  }
  function q(n2, u4, t3, i3, r3, o3, e3, f4, c3, a3) {
    var s3, h3, p3, v3, y3, d3, _2, k3, x2, M, $2, I2, P2, A2, H2, T2, j3 = u4.type;
    if (void 0 !== u4.constructor) return null;
    128 & t3.__u && (c3 = !!(32 & t3.__u), o3 = [f4 = u4.__e = t3.__e]), (s3 = l.__b) && s3(u4);
    n: if ("function" == typeof j3) {
      h3 = e3.length;
      try {
        if (x2 = u4.props, M = j3.prototype && j3.prototype.render, $2 = (s3 = j3.contextType) && i3[s3.__c], I2 = s3 ? $2 ? $2.props.value : s3.__ : i3, t3.__c ? k3 = (p3 = u4.__c = t3.__c).__ = p3.__E : (M ? u4.__c = p3 = new j3(x2, I2) : (u4.__c = p3 = new C(x2, I2), p3.constructor = j3, p3.render = Q), $2 && $2.sub(p3), p3.state || (p3.state = {}), p3.__n = i3, v3 = p3.__d = true, p3.__h = [], p3._sb = []), M && null == p3.__s && (p3.__s = p3.state), M && null != j3.getDerivedStateFromProps && (p3.__s == p3.state && (p3.__s = m({}, p3.__s)), m(p3.__s, j3.getDerivedStateFromProps(x2, p3.__s))), y3 = p3.props, d3 = p3.state, p3.__v = u4, v3) M && null == j3.getDerivedStateFromProps && null != p3.componentWillMount && p3.componentWillMount(), M && null != p3.componentDidMount && p3.__h.push(p3.componentDidMount);
        else {
          if (M && null == j3.getDerivedStateFromProps && x2 !== y3 && null != p3.componentWillReceiveProps && p3.componentWillReceiveProps(x2, I2), u4.__v == t3.__v || !p3.__e && null != p3.shouldComponentUpdate && false === p3.shouldComponentUpdate(x2, p3.__s, I2)) {
            u4.__v != t3.__v && (p3.props = x2, p3.state = p3.__s, p3.__d = false), u4.__e = t3.__e, u4.__k = t3.__k, u4.__k.some(function(n3) {
              n3 && (n3.__ = u4);
            }), w.push.apply(p3.__h, p3._sb), p3._sb = [], p3.__h.length && e3.push(p3);
            break n;
          }
          null != p3.componentWillUpdate && p3.componentWillUpdate(x2, p3.__s, I2), M && null != p3.componentDidUpdate && p3.__h.push(function() {
            p3.componentDidUpdate(y3, d3, _2);
          });
        }
        if (p3.context = I2, p3.props = x2, p3.__P = n2, p3.__e = false, P2 = l.__r, A2 = 0, M) p3.state = p3.__s, p3.__d = false, P2 && P2(u4), s3 = p3.render(p3.props, p3.state, p3.context), w.push.apply(p3.__h, p3._sb), p3._sb = [];
        else do {
          p3.__d = false, P2 && P2(u4), s3 = p3.render(p3.props, p3.state, p3.context), p3.state = p3.__s;
        } while (p3.__d && ++A2 < 25);
        p3.state = p3.__s, null != p3.getChildContext && (i3 = m(m({}, i3), p3.getChildContext())), M && !v3 && null != p3.getSnapshotBeforeUpdate && (_2 = p3.getSnapshotBeforeUpdate(y3, d3)), H2 = null != s3 && s3.type === S && null == s3.key ? E(s3.props.children) : s3, f4 = L(n2, g(H2) ? H2 : [H2], u4, t3, i3, r3, o3, e3, f4, c3, a3), p3.base = u4.__e, u4.__u &= -161, p3.__h.length && e3.push(p3), k3 && (p3.__E = p3.__ = null);
      } catch (n3) {
        if (e3.length = h3, u4.__v = null, c3 || null != o3) if (n3.then) {
          for (u4.__u |= c3 ? 160 : 128; f4 && 8 == f4.nodeType && f4.nextSibling; ) f4 = f4.nextSibling;
          null != o3 && (o3[o3.indexOf(f4)] = null), u4.__e = f4;
        } else {
          if (null != o3) for (T2 = o3.length; T2--; ) b(o3[T2]);
          B(u4);
        }
        else u4.__e = t3.__e, !u4.__k && t3.__k && (u4.__k = t3.__k), n3.then || B(u4);
        l.__e(n3, u4, t3);
      }
    } else null == o3 && u4.__v == t3.__v ? (u4.__k = t3.__k, u4.__e = t3.__e) : f4 = u4.__e = G(t3.__e, u4, t3, i3, r3, o3, e3, c3, a3);
    return (s3 = l.diffed) && s3(u4), 128 & u4.__u ? void 0 : f4;
  }
  function B(n2) {
    n2 && (n2.__c && (n2.__c.__e = true), n2.__k && n2.__k.some(B));
  }
  function D(n2, u4, t3) {
    for (var i3 = 0; i3 < t3.length; i3++) J(t3[i3], t3[++i3], t3[++i3]);
    l.__c && l.__c(u4, n2), n2.some(function(u5) {
      try {
        n2 = u5.__h, u5.__h = [], n2.some(function(n3) {
          n3.call(u5);
        });
      } catch (n3) {
        l.__e(n3, u5.__v);
      }
    });
  }
  function E(n2) {
    return "object" != typeof n2 || null == n2 || n2.__b > 0 ? n2 : g(n2) ? n2.map(E) : void 0 !== n2.constructor ? null : m({}, n2);
  }
  function G(u4, t3, i3, r3, o3, e3, f4, c3, a3) {
    var s3, h3, p3, v3, y3, w3, _2, m3 = i3.props || d, k3 = t3.props, x2 = t3.type;
    if ("svg" == x2 ? o3 = "http://www.w3.org/2000/svg" : "math" == x2 ? o3 = "http://www.w3.org/1998/Math/MathML" : o3 || (o3 = "http://www.w3.org/1999/xhtml"), null != e3) {
      for (s3 = 0; s3 < e3.length; s3++) if ((y3 = e3[s3]) && "setAttribute" in y3 == !!x2 && (x2 ? y3.localName == x2 : 3 == y3.nodeType)) {
        u4 = y3, e3[s3] = null;
        break;
      }
    }
    if (null == u4) {
      if (null == x2) return document.createTextNode(k3);
      u4 = document.createElementNS(o3, x2, k3.is && k3), c3 && (l.__m && l.__m(t3, e3), c3 = false), e3 = null;
    }
    if (null == x2) m3 === k3 || c3 && u4.data == k3 || (u4.data = k3);
    else {
      if (e3 = "textarea" == x2 && null != k3.defaultValue ? null : e3 && n.call(u4.childNodes), !c3 && null != e3) for (m3 = {}, s3 = 0; s3 < u4.attributes.length; s3++) m3[(y3 = u4.attributes[s3]).name] = y3.value;
      for (s3 in m3) y3 = m3[s3], "dangerouslySetInnerHTML" == s3 ? p3 = y3 : "children" == s3 || s3 in k3 || "value" == s3 && "defaultValue" in k3 || "checked" == s3 && "defaultChecked" in k3 || N(u4, s3, null, y3, o3);
      for (s3 in k3) y3 = k3[s3], "children" == s3 ? v3 = y3 : "dangerouslySetInnerHTML" == s3 ? h3 = y3 : "value" == s3 ? w3 = y3 : "checked" == s3 ? _2 = y3 : c3 && "function" != typeof y3 || m3[s3] === y3 || N(u4, s3, y3, m3[s3], o3);
      if (h3) c3 || p3 && (h3.__html == p3.__html || h3.__html == u4.innerHTML) || (u4.innerHTML = h3.__html), t3.__k = [];
      else if (p3 && (u4.innerHTML = ""), L("template" == t3.type ? u4.content : u4, g(v3) ? v3 : [v3], t3, i3, r3, "foreignObject" == x2 ? "http://www.w3.org/1999/xhtml" : o3, e3, f4, e3 ? e3[0] : i3.__k && $(i3, 0), c3, a3), null != e3) for (s3 = e3.length; s3--; ) b(e3[s3]);
      c3 && "textarea" != x2 || (s3 = "value", "progress" == x2 && null == w3 ? u4.removeAttribute("value") : null != w3 && (w3 !== u4[s3] || "progress" == x2 && !w3 || "option" == x2 && w3 != m3[s3]) && N(u4, s3, w3, m3[s3], o3), s3 = "checked", null != _2 && _2 != u4[s3] && N(u4, s3, _2, m3[s3], o3));
    }
    return u4;
  }
  function J(n2, u4, t3) {
    try {
      if ("function" == typeof n2) {
        var i3 = "function" == typeof n2.__u;
        i3 && n2.__u(), i3 && null == u4 || (n2.__u = n2(u4));
      } else n2.current = u4;
    } catch (n3) {
      l.__e(n3, t3);
    }
  }
  function K(n2, u4, t3) {
    var i3, r3;
    if (l.unmount && l.unmount(n2), (i3 = n2.ref) && (i3.current && i3.current != n2.__e || J(i3, null, u4)), null != (i3 = n2.__c)) {
      if (i3.componentWillUnmount) try {
        i3.componentWillUnmount();
      } catch (n3) {
        l.__e(n3, u4);
      }
      i3.base = i3.__P = i3.__n = null;
    }
    if (i3 = n2.__k) for (r3 = 0; r3 < i3.length; r3++) i3[r3] && K(i3[r3], u4, t3 || "function" != typeof n2.type);
    t3 || b(n2.__e), n2.__c = n2.__ = n2.__e = void 0;
  }
  function Q(n2, l3, u4) {
    return this.constructor(n2, u4);
  }
  function R(u4, t3, i3) {
    var r3, o3, e3, f4;
    t3 == document && (t3 = document.documentElement), l.__ && l.__(u4, t3), o3 = (r3 = "function" == typeof i3) ? null : i3 && i3.__k || t3.__k, e3 = [], f4 = [], q(t3, u4 = (!r3 && i3 || t3).__k = k(S, null, [u4]), o3 || d, d, t3.namespaceURI, !r3 && i3 ? [i3] : o3 ? null : t3.firstChild ? n.call(t3.childNodes) : null, e3, !r3 && i3 ? i3 : o3 ? o3.__e : t3.firstChild, r3, f4), D(e3, u4, f4), u4.props.children = null;
  }
  n = w.slice, l = { __e: function(n2, l3, u4, t3) {
    for (var i3, r3, o3; l3 = l3.__; ) if ((i3 = l3.__c) && !i3.__) try {
      if ((r3 = i3.constructor) && null != r3.getDerivedStateFromError && (i3.setState(r3.getDerivedStateFromError(n2)), o3 = i3.__d), null != i3.componentDidCatch && (i3.componentDidCatch(n2, t3 || {}), o3 = i3.__d), o3) return i3.__E = i3;
    } catch (l4) {
      n2 = l4;
    }
    throw n2;
  } }, u = 0, t = function(n2) {
    return null != n2 && void 0 === n2.constructor;
  }, C.prototype.setState = function(n2, l3) {
    var u4;
    u4 = null != this.__s && this.__s != this.state ? this.__s : this.__s = m({}, this.state), "function" == typeof n2 && (n2 = n2(m({}, u4), this.props)), n2 && m(u4, n2), null != n2 && this.__v && (l3 && this._sb.push(l3), A(this));
  }, C.prototype.forceUpdate = function(n2) {
    this.__v && (this.__e = true, n2 && this.__h.push(n2), A(this));
  }, C.prototype.render = S, i = [], o = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = function(n2, l3) {
    return n2.__v.__b - l3.__v.__b;
  }, H.__r = 0, f = Math.random().toString(8), c = "__d" + f, a = "__a" + f, s = /(PointerCapture)$|Capture$/i, h = 0, p = V(false), v = V(true), y = 0;

  // node_modules/preact/hooks/dist/hooks.module.js
  var t2;
  var r2;
  var u2;
  var i2;
  var o2 = 0;
  var f2 = [];
  var c2 = l;
  var e2 = c2.__b;
  var a2 = c2.__r;
  var v2 = c2.diffed;
  var l2 = c2.__c;
  var m2 = c2.unmount;
  var p2 = c2.__;
  function s2(n2, t3) {
    c2.__h && c2.__h(r2, n2, o2 || t3), o2 = 0;
    var u4 = r2.__H || (r2.__H = { __: [], __h: [] });
    return n2 >= u4.__.length && u4.__.push({}), u4.__[n2];
  }
  function d2(n2) {
    return o2 = 1, y2(D2, n2);
  }
  function y2(n2, u4, i3) {
    var o3 = s2(t2++, 2);
    if (o3.t = n2, !o3.__c && (o3.__ = [i3 ? i3(u4) : D2(void 0, u4), function(n3) {
      var t3 = o3.__N ? o3.__N[0] : o3.__[0], r3 = o3.t(t3, n3);
      t3 !== r3 && (o3.__N = [r3, o3.__[1]], o3.__c.setState({}));
    }], o3.__c = r2, !r2.__f)) {
      var f4 = function(n3, t3, r3) {
        if (!o3.__c.__H) return true;
        var u5 = false, i4 = o3.__c.props !== n3;
        if (o3.__c.__H.__.some(function(n4) {
          if (n4.__N) {
            u5 = true;
            var t4 = n4.__[0];
            n4.__ = n4.__N, n4.__N = void 0, t4 !== n4.__[0] && (i4 = true);
          }
        }), c3) {
          var f5 = c3.call(this, n3, t3, r3);
          return u5 ? f5 || i4 : f5;
        }
        return !u5 || i4;
      };
      r2.__f = true;
      var c3 = r2.shouldComponentUpdate, e3 = r2.componentWillUpdate;
      r2.componentWillUpdate = function(n3, t3, r3) {
        if (this.__e) {
          var u5 = c3;
          c3 = void 0, f4(n3, t3, r3), c3 = u5;
        }
        e3 && e3.call(this, n3, t3, r3);
      }, r2.shouldComponentUpdate = f4;
    }
    return o3.__N || o3.__;
  }
  function h2(n2, u4) {
    var i3 = s2(t2++, 3);
    !c2.__s && C2(i3.__H, u4) && (i3.__ = n2, i3.u = u4, r2.__H.__h.push(i3));
  }
  function j2() {
    for (var n2; n2 = f2.shift(); ) {
      var t3 = n2.__H;
      if (n2.__P && t3) try {
        t3.__h.some(z2), t3.__h.some(B2), t3.__h = [];
      } catch (r3) {
        t3.__h = [], c2.__e(r3, n2.__v);
      }
    }
  }
  c2.__b = function(n2) {
    r2 = null, e2 && e2(n2);
  }, c2.__ = function(n2, t3) {
    n2 && t3.__k && t3.__k.__m && (n2.__m = t3.__k.__m), p2 && p2(n2, t3);
  }, c2.__r = function(n2) {
    a2 && a2(n2), t2 = 0;
    var i3 = (r2 = n2.__c).__H;
    i3 && (u2 === r2 ? (i3.__h = [], r2.__h = [], i3.__.some(function(n3) {
      n3.__N && (n3.__ = n3.__N), n3.u = n3.__N = void 0;
    })) : (i3.__h.length && j2(), t2 = 0)), u2 = r2;
  }, c2.diffed = function(n2) {
    v2 && v2(n2);
    var t3 = n2.__c;
    t3 && t3.__H && (t3.__H.__h.length && (1 !== f2.push(t3) && i2 === c2.requestAnimationFrame || ((i2 = c2.requestAnimationFrame) || w2)(j2)), t3.__H.__.some(function(n3) {
      n3.u && (n3.__H = n3.u, n3.u = void 0);
    })), u2 = r2 = null;
  }, c2.__c = function(n2, t3) {
    t3.some(function(n3) {
      try {
        n3.__h.some(z2), n3.__h = n3.__h.filter(function(n4) {
          return !n4.__ || B2(n4);
        });
      } catch (r3) {
        t3.some(function(n4) {
          n4.__h && (n4.__h = []);
        }), t3 = [], c2.__e(r3, n3.__v);
      }
    }), l2 && l2(n2, t3);
  }, c2.unmount = function(n2) {
    m2 && m2(n2);
    var t3, r3 = n2.__c;
    r3 && r3.__H && (r3.__H.__.some(function(n3) {
      try {
        z2(n3);
      } catch (n4) {
        t3 = n4;
      }
    }), r3.__H = void 0, t3 && c2.__e(t3, r3.__v));
  };
  var k2 = "function" == typeof requestAnimationFrame;
  function w2(n2) {
    var t3, r3 = function() {
      clearTimeout(u4), k2 && cancelAnimationFrame(t3), setTimeout(n2);
    }, u4 = setTimeout(r3, 35);
    k2 && (t3 = requestAnimationFrame(r3));
  }
  function z2(n2) {
    var t3 = r2, u4 = n2.__c;
    "function" == typeof u4 && (n2.__c = void 0, u4()), r2 = t3;
  }
  function B2(n2) {
    var t3 = r2;
    n2.__c = n2.__(), r2 = t3;
  }
  function C2(n2, t3) {
    return !n2 || n2.length !== t3.length || t3.some(function(t4, r3) {
      return t4 !== n2[r3];
    });
  }
  function D2(n2, t3) {
    return "function" == typeof t3 ? t3(n2) : t3;
  }

  // src/shared/el.ts
  function el(tag, options = {}, children) {
    const node = document.createElement(tag);
    if (options.class !== void 0) node.className = options.class;
    if (options.text !== void 0) node.textContent = options.text;
    if (options.html !== void 0) node.innerHTML = options.html;
    if (options.attrs) {
      for (const [name, value] of Object.entries(options.attrs)) {
        if (value == null || value === false) continue;
        node.setAttribute(name, value === true ? "" : String(value));
      }
    }
    if (options.on) {
      for (const [type, handler] of Object.entries(options.on)) {
        node.addEventListener(type, handler);
      }
    }
    if (children !== void 0) {
      for (const child of Array.isArray(children) ? children : [children]) {
        if (child == null || child === false) continue;
        node.append(child);
      }
    }
    return node;
  }

  // src/shared/overlay.ts
  var stack = [];
  var FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  function visibleFocusables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (el2) => !el2.hasAttribute("hidden") && el2.getClientRects().length > 0
    );
  }
  function registerOverlay(close) {
    stack.push(close);
    return () => {
      const i3 = stack.lastIndexOf(close);
      if (i3 >= 0) stack.splice(i3, 1);
    };
  }
  document.addEventListener("keydown", (e3) => {
    if (e3.key !== "Escape" || stack.length === 0) return;
    e3.preventDefault();
    e3.stopPropagation();
    stack[stack.length - 1]();
  });
  function createModal(opts) {
    const closeBtn = el("button", {
      class: "koi-modal-close",
      text: "\u2715",
      attrs: { type: "button", "aria-label": "Close" }
    });
    const body = el("div", { class: "koi-modal-body" });
    const modal = el(
      "div",
      {
        class: "koi-modal",
        attrs: { role: "dialog", "aria-modal": "true", "aria-label": opts.ariaLabel ?? opts.title }
      },
      [
        el("div", { class: "koi-modal-header" }, [
          el("h2", { class: "koi-modal-title", text: opts.title }),
          closeBtn
        ]),
        body,
        el("div", { class: "koi-modal-footer" })
      ]
    );
    if (opts.variant) modal.classList.add(opts.variant);
    const backdrop = el("div", { class: "koi-modal-backdrop" }, modal);
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
    let isOpen = false;
    let opener = null;
    let unregister = null;
    const openCbs = [];
    const closeCbs = [];
    function open() {
      if (isOpen) return;
      isOpen = true;
      opener = document.activeElement;
      if (!backdrop.isConnected) document.body.appendChild(backdrop);
      backdrop.hidden = false;
      unregister = registerOverlay(close);
      closeBtn.focus();
      for (const cb of openCbs) cb();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      backdrop.hidden = true;
      unregister?.();
      unregister = null;
      opener?.focus?.();
      opener = null;
      for (const cb of closeCbs) cb();
    }
    function toggle() {
      if (isOpen) close();
      else open();
    }
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e3) => {
      if (e3.target === backdrop) close();
    });
    modal.addEventListener("keydown", (e3) => {
      if (e3.key !== "Tab") return;
      const focusable = visibleFocusables(modal);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e3.shiftKey) {
        if (active === first) {
          e3.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e3.preventDefault();
        first.focus();
      }
    });
    return {
      backdrop,
      body,
      open,
      close,
      toggle,
      get isOpen() {
        return isOpen;
      },
      onOpen(cb) {
        openCbs.push(cb);
      },
      onClose(cb) {
        closeCbs.push(cb);
      }
    };
  }
  function createConfirmDialog() {
    const modal = createModal({ title: "Confirm", ariaLabel: "Confirm" });
    const titleEl = modal.backdrop.querySelector(".koi-modal-title");
    const msgEl = document.createElement("p");
    msgEl.className = "koi-confirm-msg";
    modal.body.appendChild(msgEl);
    const footer = modal.backdrop.querySelector(".koi-modal-footer");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "koi-confirm-btn";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    footer.append(cancelBtn, okBtn);
    let resolve = null;
    const settle = (ok) => {
      const r3 = resolve;
      resolve = null;
      r3?.(ok);
    };
    cancelBtn.addEventListener("click", () => {
      settle(false);
      modal.close();
    });
    okBtn.addEventListener("click", () => {
      settle(true);
      modal.close();
    });
    modal.onClose(() => settle(false));
    return {
      ask(req) {
        settle(false);
        if (titleEl) titleEl.textContent = req.title;
        msgEl.textContent = req.message;
        cancelBtn.textContent = req.cancelLabel ?? "Cancel";
        okBtn.textContent = req.confirmLabel;
        okBtn.className = req.danger ? "koi-confirm-btn koi-confirm-btn-danger" : "koi-confirm-btn";
        return new Promise((res) => {
          resolve = res;
          modal.open();
          cancelBtn.focus();
        });
      }
    };
  }
  var sharedConfirm = null;
  function koiConfirm(req) {
    return (sharedConfirm ??= createConfirmDialog()).ask(req);
  }

  // node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
  var f3 = 0;
  function u3(e3, t3, n2, o3, i3, u4) {
    t3 || (t3 = {});
    var a3, c3, p3 = t3;
    if ("ref" in p3) for (c3 in p3 = {}, t3) "ref" == c3 ? a3 = t3[c3] : p3[c3] = t3[c3];
    var l3 = { type: e3, props: p3, key: n2, ref: a3, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: --f3, __i: -1, __u: 0, __source: i3, __self: u4 };
    if ("function" == typeof e3 && (a3 = e3.defaultProps)) for (c3 in a3) void 0 === p3[c3] && (p3[c3] = a3[c3]);
    return l.vnode && l.vnode(l3), l3;
  }

  // src/model/SourceControlPanel.tsx
  var STATUS_GLYPH = {
    modified: "M",
    added: "A",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "U",
    conflicted: "!"
  };
  var STATUS_LABEL = {
    modified: "modified",
    added: "added",
    deleted: "deleted",
    renamed: "renamed",
    copied: "copied",
    untracked: "untracked",
    conflicted: "conflicted"
  };
  function formatDate(date) {
    const m3 = /^(\d{4}-\d{2}-\d{2})/.exec(date);
    return m3 ? m3[1] : date;
  }
  function SourceControlPanel(props) {
    const { git, folderToken } = props;
    const [status, setStatus] = d2(null);
    const [log, setLog] = d2([]);
    const [branches, setBranches] = d2([]);
    const [message, setMessage] = d2("");
    const [busy, setBusy] = d2(false);
    const [committing, setCommitting] = d2(false);
    const [error, setError] = d2(null);
    const [actionError, setActionError] = d2(null);
    const [openDiff, setOpenDiff] = d2(null);
    const [diffText, setDiffText] = d2("");
    const [reloadTick, setReloadTick] = d2(0);
    const reload = () => setReloadTick((t3) => t3 + 1);
    h2(() => {
      if (!git.canUseGit) return;
      let alive = true;
      setBusy(true);
      void Promise.resolve().then(() => git.gitStatus(folderToken)).then(async (st) => {
        if (!alive) return;
        const [lg, br] = await Promise.all([
          git.gitLog(folderToken).catch(() => []),
          git.gitBranches(folderToken).catch(() => [])
        ]);
        if (!alive) return;
        setStatus(st);
        setLog(lg);
        setBranches(br);
        setError(null);
        setBusy(false);
      }).catch(() => {
        if (!alive) return;
        setStatus(null);
        setError("not-a-repo");
        setBusy(false);
      });
      return () => {
        alive = false;
      };
    }, [git, folderToken, props.refreshNonce, reloadTick]);
    async function mutate(op) {
      setBusy(true);
      setActionError(null);
      try {
        await op();
        reload();
      } catch (e3) {
        setBusy(false);
        setActionError(String(e3));
      }
    }
    const onStage = (relPath) => void mutate(() => git.gitStage(folderToken, [relPath]));
    const onUnstage = (relPath) => void mutate(() => git.gitUnstage(folderToken, [relPath]));
    const onCheckout = (branch) => {
      if (!status || branch === status.branch) return;
      void mutate(() => git.gitCheckout(folderToken, branch));
    };
    function onCommit() {
      const msg = message.trim();
      if (!msg) return;
      setCommitting(true);
      void mutate(async () => {
        try {
          const unsaved = props.dirtyCount ?? 0;
          if (unsaved > 0 && props.onSaveAll) {
            const ok = await koiConfirm({
              title: "Save changes before committing?",
              message: `You have ${unsaved} unsaved file${unsaved === 1 ? "" : "s"}. Git commits what's saved to disk \u2014 save all first so this commit includes your latest edits.`,
              confirmLabel: "Save all & commit",
              cancelLabel: "Cancel"
            });
            if (!ok) return;
            await props.onSaveAll();
          }
          await git.gitCommit(folderToken, msg);
          setMessage("");
        } finally {
          setCommitting(false);
        }
      });
    }
    async function onToggleDiff(f4) {
      if (openDiff && openDiff.relPath === f4.relPath && openDiff.staged === f4.staged) {
        setOpenDiff(null);
        return;
      }
      setOpenDiff({ relPath: f4.relPath, staged: f4.staged });
      try {
        setDiffText(await git.gitDiff(folderToken, f4.relPath, f4.staged));
      } catch {
        setDiffText("");
      }
    }
    if (!git.canUseGit) {
      return /* @__PURE__ */ u3("div", { class: "koi-sc koi-sc-empty", children: /* @__PURE__ */ u3("div", { class: "koi-rview-empty", children: [
        /* @__PURE__ */ u3("h3", { class: "koi-rview-empty-title", children: "Source control" }),
        /* @__PURE__ */ u3("p", { class: "muted", children: "Source control is available in the desktop app \u2014 Git is unavailable in the browser." })
      ] }) });
    }
    if (error === "not-a-repo") {
      return /* @__PURE__ */ u3("div", { class: "koi-sc koi-sc-empty", children: /* @__PURE__ */ u3("div", { class: "koi-rview-empty", children: [
        /* @__PURE__ */ u3("h3", { class: "koi-rview-empty-title", children: "Source control" }),
        /* @__PURE__ */ u3("p", { class: "muted", children: [
          "This folder isn\u2019t a git repository. Initialize one with ",
          /* @__PURE__ */ u3("code", { children: "git init" }),
          " to track changes here."
        ] })
      ] }) });
    }
    const files = status?.files ?? [];
    const staged = files.filter((f4) => f4.staged);
    const unstaged = files.filter((f4) => !f4.staged && f4.status !== "untracked");
    const untracked = files.filter((f4) => !f4.staged && f4.status === "untracked");
    const hasStaged = staged.length > 0;
    const branchOptions = status && !branches.includes(status.branch) ? [status.branch, ...branches] : branches;
    const fileRow = (f4) => {
      const expanded = openDiff?.relPath === f4.relPath && openDiff?.staged === f4.staged;
      return /* @__PURE__ */ u3("li", { class: "koi-sc-file", "data-relpath": f4.relPath, children: [
        /* @__PURE__ */ u3("div", { class: "koi-sc-file-row", children: [
          /* @__PURE__ */ u3(
            "button",
            {
              type: "button",
              class: "koi-sc-file-open",
              "aria-expanded": expanded,
              onClick: () => void onToggleDiff(f4),
              children: [
                /* @__PURE__ */ u3("span", { class: `koi-sc-glyph koi-sc-glyph-${f4.status}`, "aria-hidden": "true", children: STATUS_GLYPH[f4.status] }),
                /* @__PURE__ */ u3("span", { class: "koi-sc-file-path", children: f4.relPath }),
                /* @__PURE__ */ u3("span", { class: "koi-sr-only", children: [
                  " ",
                  STATUS_LABEL[f4.status]
                ] })
              ]
            }
          ),
          f4.staged ? /* @__PURE__ */ u3("button", { type: "button", class: "koi-sc-act", disabled: busy, onClick: () => onUnstage(f4.relPath), children: [
            "Unstage",
            /* @__PURE__ */ u3("span", { class: "koi-sr-only", children: [
              " ",
              f4.relPath
            ] })
          ] }) : /* @__PURE__ */ u3("button", { type: "button", class: "koi-sc-act", disabled: busy, onClick: () => onStage(f4.relPath), children: [
            "Stage",
            /* @__PURE__ */ u3("span", { class: "koi-sr-only", children: [
              " ",
              f4.relPath
            ] })
          ] })
        ] }),
        expanded && /* @__PURE__ */ u3("pre", { class: "koi-sc-diff", "aria-label": `Diff for ${f4.relPath}`, children: diffText || "No changes to show." })
      ] }, `${f4.staged ? "s" : "w"}:${f4.relPath}`);
    };
    const fileGroup = (label, list) => {
      if (list.length === 0) return null;
      return /* @__PURE__ */ u3("section", { class: "koi-sc-group", "aria-label": label, children: [
        /* @__PURE__ */ u3("h4", { class: "koi-sc-group-title", children: [
          label,
          " ",
          /* @__PURE__ */ u3("span", { class: "koi-sc-count muted", children: list.length })
        ] }),
        /* @__PURE__ */ u3("ul", { class: "koi-sc-files", children: list.map(fileRow) })
      ] });
    };
    return /* @__PURE__ */ u3("div", { class: "koi-sc", children: [
      /* @__PURE__ */ u3("header", { class: "koi-sc-head", children: [
        /* @__PURE__ */ u3("div", { class: "koi-sc-branch", children: [
          /* @__PURE__ */ u3("span", { class: "koi-sc-branch-icon", "aria-hidden": "true", children: "\u2387" }),
          branchOptions.length > 0 ? /* @__PURE__ */ u3(
            "select",
            {
              class: "koi-sc-branch-select",
              "aria-label": "Current branch \u2014 switch branch",
              value: status?.branch ?? "",
              disabled: busy,
              onChange: (e3) => onCheckout(e3.currentTarget.value),
              children: branchOptions.map((b2) => /* @__PURE__ */ u3("option", { value: b2, children: b2 }, b2))
            }
          ) : /* @__PURE__ */ u3("span", { class: "koi-sc-branch-name", children: status?.branch ?? "\u2026" })
        ] }),
        /* @__PURE__ */ u3("button", { type: "button", class: "koi-sc-refresh koi-docs-new-btn", disabled: busy, onClick: reload, children: "Refresh" })
      ] }),
      actionError && /* @__PURE__ */ u3("p", { class: "koi-sc-error", role: "alert", children: actionError }),
      status === null ? /* @__PURE__ */ u3("p", { class: "koi-docs-empty", children: "Loading changes\u2026" }) : /* @__PURE__ */ u3(S, { children: [
        /* @__PURE__ */ u3("div", { class: "koi-sc-commit", children: [
          /* @__PURE__ */ u3(
            "textarea",
            {
              class: "koi-sc-commit-input",
              "aria-label": "Commit message",
              rows: 2,
              placeholder: "Message (what changed and why)",
              value: message,
              disabled: busy,
              onInput: (e3) => setMessage(e3.currentTarget.value)
            }
          ),
          /* @__PURE__ */ u3(
            "button",
            {
              type: "button",
              class: "koi-sc-commit-btn koi-docs-save",
              disabled: busy || committing || message.trim().length === 0 || !hasStaged,
              onClick: onCommit,
              children: "Commit"
            }
          )
        ] }),
        fileGroup("Staged Changes", staged),
        fileGroup("Changes", unstaged),
        fileGroup("Untracked", untracked),
        files.length === 0 && /* @__PURE__ */ u3("p", { class: "koi-docs-empty", children: "No changes \u2014 the working tree is clean." }),
        /* @__PURE__ */ u3("section", { class: "koi-sc-group koi-sc-log-group", "aria-label": "Recent commits", children: [
          /* @__PURE__ */ u3("h4", { class: "koi-sc-group-title", children: "Recent commits" }),
          log.length === 0 ? /* @__PURE__ */ u3("p", { class: "koi-docs-empty", children: "No commits yet." }) : /* @__PURE__ */ u3("ul", { class: "koi-sc-log", children: log.slice(0, 10).map((c3) => /* @__PURE__ */ u3("li", { class: "koi-sc-log-item", children: [
            /* @__PURE__ */ u3("code", { class: "koi-sc-log-sha", children: c3.sha.slice(0, 7) }),
            /* @__PURE__ */ u3("span", { class: "koi-sc-log-msg", children: c3.message }),
            /* @__PURE__ */ u3("span", { class: "koi-sc-log-meta muted", children: [
              c3.author,
              " \xB7 ",
              formatDate(c3.date)
            ] })
          ] }, c3.sha)) })
        ] })
      ] })
    ] });
  }

  // src/model/SourceControlPanel.stories.tsx
  var TOKEN = "file:///work";
  function makeGit(files, log = []) {
    const snapshot = () => ({ branch: "main", files: files.map((f4) => ({ ...f4 })) });
    return {
      canUseGit: true,
      gitStatus: async () => snapshot(),
      gitDiff: async () => "diff --git a/x b/x\n@@ -1 +1 @@\n-old line\n+new line",
      gitStage: async () => {
      },
      gitUnstage: async () => {
      },
      gitCommit: async () => {
      },
      gitBranches: async () => ["main", "feature/scm"],
      gitCheckout: async () => {
      },
      gitLog: async () => log
    };
  }
  var seededLog = [
    { sha: "abcdef1234567", author: "Ada", date: "2026-06-01T10:00:00Z", message: "Seed the model" },
    { sha: "0123456abcdef", author: "Grace", date: "2026-05-28T09:30:00Z", message: "Add ordering context" }
  ];
  var changedFiles = [
    { relPath: "ordering/order.koi", staged: true, status: "modified" },
    { relPath: "ordering/line-item.koi", staged: false, status: "modified" },
    { relPath: "billing/invoice.koi", staged: false, status: "untracked" }
  ];
  var meta = {
    title: "Panels/SourceControlPanel",
    component: SourceControlPanel,
    parameters: { layout: "padded" },
    args: {
      git: makeGit(changedFiles, seededLog),
      folderToken: TOKEN
    }
  };
  var SourceControlPanel_stories_default = meta;
  var Desktop = {};
  var CleanTree = {
    args: { git: makeGit([], seededLog) }
  };
  var BrowserDesktopOnly = {
    args: {
      git: { ...makeGit([]), canUseGit: false }
    }
  };
  var NotARepository = {
    args: {
      git: {
        ...makeGit([]),
        gitStatus: async () => {
          throw new Error("not a git repository");
        }
      }
    }
  };

  // .ds-adapter/card-runtime.js
  function mountStoryPreact(mod, storyName) {
    const meta2 = mod.default || {};
    const story = mod[storyName] || {};
    const args = { ...meta2.args || {}, ...story.args || {} };
    const renderFn = story.render || meta2.render;
    const vnode = renderFn ? renderFn(args, { args }) : k(meta2.component, args);
    R(vnode, document.getElementById("root"));
  }

  // .ds-adapter/out/entries/card-SourceControlPanel.js
  mountStoryPreact(SourceControlPanel_stories_exports, "CleanTree");
})();
