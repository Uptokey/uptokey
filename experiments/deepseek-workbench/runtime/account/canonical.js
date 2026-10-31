var UptokeyCanonicalAccount = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region \0rolldown/runtime.js
	var __defProp = Object.defineProperty;
	var __esmMin = (fn, res, err) => () => {
		if (err) throw err[0];
		try {
			return fn && (res = fn(fn = 0)), res;
		} catch (e) {
			throw err = [e], e;
		}
	};
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
	var __exportAll = (all, no_symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/node_modules/preact/dist/preact.js
	var require_preact = /* @__PURE__ */ __commonJSMin(((exports) => {
		var n;
		var l;
		var t;
		var u;
		var r;
		var i;
		var o;
		var e;
		var f;
		var c;
		var s;
		var a;
		var h;
		var p;
		var v;
		var y;
		var d = {};
		var w = [];
		var _ = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
		var g = Array.isArray;
		function x(n, l) {
			for (var t in l) n[t] = l[t];
			return n;
		}
		function m(n) {
			n && n.parentNode && n.parentNode.removeChild(n);
		}
		function b(l, t, u) {
			var r, i, o, e = {};
			for (o in t) "key" == o ? r = t[o] : "ref" == o ? i = t[o] : e[o] = t[o];
			if (arguments.length > 2 && (e.children = arguments.length > 3 ? n.call(arguments, 2) : u), "function" == typeof l && null != l.defaultProps) for (o in l.defaultProps) void 0 === e[o] && (e[o] = l.defaultProps[o]);
			return k(l, e, r, i, null);
		}
		function k(n, u, r, i, o) {
			var e = {
				type: n,
				props: u,
				key: r,
				ref: i,
				__k: null,
				__: null,
				__b: 0,
				__e: null,
				__c: null,
				constructor: void 0,
				__v: null == o ? ++t : o,
				__i: -1,
				__u: 0
			};
			return null == o && null != l.vnode && l.vnode(e), e;
		}
		function M(n) {
			return n.children;
		}
		function S(n, l) {
			this.props = n, this.context = l;
		}
		function $(n, l) {
			if (null == l) return n.__ ? $(n.__, n.__i + 1) : null;
			for (var t; l < n.__k.length; l++) if (null != (t = n.__k[l]) && null != t.__e) return t.__e;
			return "function" == typeof n.type ? $(n) : null;
		}
		function C(n) {
			if (n.__P && n.__d) {
				var t = n.__v, u = t.__e, r = [], i = [], o = x({}, t);
				o.__v = t.__v + 1, l.vnode && l.vnode(o), N(n.__P, o, t, n.__n, n.__P.namespaceURI, 32 & t.__u ? [u] : null, r, null == u ? $(t) : u, !!(32 & t.__u), i), o.__v = t.__v, o.__.__k[o.__i] = o, q(r, o, i), t.__e = t.__ = null, o.__e != u && I(o);
			}
		}
		function I(n) {
			if (null != (n = n.__) && null != n.__c) return n.__e = n.__c.base = null, n.__k.some(function(l) {
				if (null != l && null != l.__e) return n.__e = n.__c.base = l.__e;
			}), I(n);
		}
		function P(n) {
			(!n.__d && (n.__d = !0) && r.push(n) && !A.__r++ || i != l.debounceRendering) && ((i = l.debounceRendering) || o)(A);
		}
		function A() {
			try {
				for (var n, l = 1; r.length;) r.length > l && r.sort(e), n = r.shift(), l = r.length, C(n);
			} finally {
				r.length = A.__r = 0;
			}
		}
		function H(n, l, t, u, r, i, o, e, f, c, s) {
			var a, h, p, v, y, _, g = u && u.__k || w, x = l.length;
			for (f = L(t, l, g, f, x), a = 0; a < x; a++) null != (p = t.__k[a]) && (h = -1 != p.__i && g[p.__i] || d, p.__i = a, _ = N(n, p, h, r, i, o, e, f, c, s), v = p.__e, p.ref && h.ref != p.ref && (h.ref && E(h.ref, null, p), s.push(p.ref, p.__c || v, p)), null == y && null != v && (y = v), 4 & p.__u ? (f = T(p, f, n), h.__e && (h.__e = null)) : "function" == typeof p.type && void 0 !== _ ? f = _ : v && (f = v.nextSibling), p.__u &= -7);
			return t.__e = y, f;
		}
		function L(n, l, t, u, r) {
			var i, o, e, f, c, s = t.length, a = s, h = 0;
			for (n.__k = new Array(r), i = 0; i < r; i++) null != (o = l[i]) && "boolean" != typeof o && "function" != typeof o ? ("string" == typeof o || "number" == typeof o || "bigint" == typeof o || o.constructor == String ? o = n.__k[i] = k(null, o, null, null, null) : g(o) ? o = n.__k[i] = k(M, { children: o }, null, null, null) : void 0 === o.constructor && o.__b > 0 ? o = n.__k[i] = k(o.type, o.props, o.key, o.ref ? o.ref : null, o.__v) : n.__k[i] = o, f = i + h, o.__ = n, o.__b = n.__b + 1, e = null, -1 != (c = o.__i = j(o, t, f, a)) && (a--, (e = t[c]) && (e.__u |= 2)), null == e || null == e.__v ? (-1 == c && (r > s ? h-- : r < s && h++), "function" != typeof o.type && (o.__u |= 4)) : c != f && (c == f - 1 ? h-- : c == f + 1 ? h++ : (c > f ? h-- : h++, o.__u |= 4))) : n.__k[i] = null;
			if (a) for (i = 0; i < s; i++) null != (e = t[i]) && 0 == (2 & e.__u) && (e.__e == u && (u = $(e)), G(e, e));
			return u;
		}
		function T(n, l, t) {
			var u, r;
			if ("function" == typeof n.type) {
				for (u = n.__k, r = 0; u && r < u.length; r++) u[r] && (u[r].__ = n, l = T(u[r], l, t));
				return l;
			}
			n.__e != l && (l && n.type && !l.parentNode && (l = $(n)), l = t.insertBefore(n.__e, l || null));
			do
				l = l && l.nextSibling;
			while (null != l && 8 == l.nodeType);
			return l;
		}
		function j(n, l, t, u) {
			var r, i, o, e = n.key, f = n.type, c = l[t], s = null != c && 0 == (2 & c.__u);
			if (null === c && null == e || s && e == c.key && f == c.type) return t;
			if (u > (s ? 1 : 0)) {
				for (r = t - 1, i = t + 1; r >= 0 || i < l.length;) if (null != (c = l[o = r >= 0 ? r-- : i++]) && 0 == (2 & c.__u) && e == c.key && f == c.type) return o;
			}
			return -1;
		}
		function F(n, l, t) {
			"-" == l[0] ? n.setProperty(l, null == t ? "" : t) : n[l] = null == t ? "" : "number" != typeof t || _.test(l) ? t : t + "px";
		}
		function O(n, l, t, u, r) {
			var i, o;
			n: if ("style" == l) if ("string" == typeof t) n.style.cssText = t;
			else {
				if ("string" == typeof u && (n.style.cssText = u = ""), u) for (l in u) t && l in t || F(n.style, l, "");
				if (t) for (l in t) u && t[l] == u[l] || F(n.style, l, t[l]);
			}
			else if ("o" == l[0] && "n" == l[1]) i = l != (l = l.replace(a, "$1")), o = l.toLowerCase(), l = o in n || "onFocusOut" == l || "onFocusIn" == l ? o.slice(2) : l.slice(2), n.l || (n.l = {}), n.l[l + i] = t, t ? u ? t[s] = u[s] : (t[s] = h, n.addEventListener(l, i ? v : p, i)) : n.removeEventListener(l, i ? v : p, i);
			else {
				if ("http://www.w3.org/2000/svg" == r) l = l.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
				else if ("width" != l && "height" != l && "href" != l && "list" != l && "form" != l && "tabIndex" != l && "download" != l && "rowSpan" != l && "colSpan" != l && "role" != l && "popover" != l && l in n) try {
					n[l] = null == t ? "" : t;
					break n;
				} catch (n) {}
				"function" == typeof t || (null == t || !1 === t && "-" != l[4] ? n.removeAttribute(l) : n.setAttribute(l, "popover" == l && 1 == t ? "" : t));
			}
		}
		function z(n) {
			return function(t) {
				if (this.l) {
					var u = this.l[t.type + n];
					if (null == t[c]) t[c] = h++;
					else if (t[c] < u[s]) return;
					return u(l.event ? l.event(t) : t);
				}
			};
		}
		function N(n, t, u, r, i, o, e, f, c, s) {
			var a, h, p, v, y, d, _, b, k, C, I, P, A, L, T, j, F = t.type;
			if (void 0 !== t.constructor) return null;
			128 & u.__u && (c = !!(32 & u.__u), o = [f = t.__e = u.__e]), (a = l.__b) && a(t);
			n: if ("function" == typeof F) {
				h = e.length;
				try {
					if (k = t.props, C = F.prototype && F.prototype.render, I = (a = F.contextType) && r[a.__c], P = a ? I ? I.props.value : a.__ : r, u.__c ? b = (p = t.__c = u.__c).__ = p.__E : (C ? t.__c = p = new F(k, P) : (t.__c = p = new S(k, P), p.constructor = F, p.render = J), I && I.sub(p), p.state || (p.state = {}), p.__n = r, v = p.__d = !0, p.__h = [], p._sb = []), C && null == p.__s && (p.__s = p.state), C && null != F.getDerivedStateFromProps && (p.__s == p.state && (p.__s = x({}, p.__s)), x(p.__s, F.getDerivedStateFromProps(k, p.__s))), y = p.props, d = p.state, p.__v = t, v) C && null == F.getDerivedStateFromProps && null != p.componentWillMount && p.componentWillMount(), C && null != p.componentDidMount && p.__h.push(p.componentDidMount);
					else {
						if (C && null == F.getDerivedStateFromProps && k !== y && null != p.componentWillReceiveProps && p.componentWillReceiveProps(k, P), t.__v == u.__v || !p.__e && null != p.shouldComponentUpdate && !1 === p.shouldComponentUpdate(k, p.__s, P)) {
							t.__v != u.__v && (p.props = k, p.state = p.__s, p.__d = !1), t.__e = u.__e, t.__k = u.__k, t.__k.some(function(n) {
								n && (n.__ = t);
							}), w.push.apply(p.__h, p._sb), p._sb = [], p.__h.length && e.push(p), f = $(u);
							break n;
						}
						null != p.componentWillUpdate && p.componentWillUpdate(k, p.__s, P), C && null != p.componentDidUpdate && p.__h.push(function() {
							p.componentDidUpdate(y, d, _);
						});
					}
					if (p.context = P, p.props = k, p.__P = n, p.__e = !1, A = l.__r, L = 0, C) p.state = p.__s, p.__d = !1, A && A(t), a = p.render(p.props, p.state, p.context), w.push.apply(p.__h, p._sb), p._sb = [];
					else do
						p.__d = !1, A && A(t), a = p.render(p.props, p.state, p.context), p.state = p.__s;
					while (p.__d && ++L < 25);
					p.state = p.__s, null != p.getChildContext && (r = x(x({}, r), p.getChildContext())), C && !v && null != p.getSnapshotBeforeUpdate && (_ = p.getSnapshotBeforeUpdate(y, d)), T = null != a && a.type === M && null == a.key ? B(a.props.children) : a, f = H(n, g(T) ? T : [T], t, u, r, i, o, e, f, c, s), p.base = t.__e, t.__u &= -161, p.__h.length && e.push(p), b && (p.__E = p.__ = null);
				} catch (n) {
					if (e.length = h, t.__v = null, c || null != o) {
						if (n.then) {
							for (t.__u |= c ? 160 : 128; f && 8 == f.nodeType && f.nextSibling;) f = f.nextSibling;
							null != o && (o[o.indexOf(f)] = null), t.__e = f;
						} else if (null != o) for (j = o.length; j--;) m(o[j]);
					} else t.__e = u.__e;
					t.__k ??= u.__k || [], n.then || V(t), l.__e(n, t, u);
				}
			} else null == o && t.__v == u.__v ? (t.__k = u.__k, t.__e = u.__e) : f = t.__e = D(u.__e, t, u, r, i, o, e, c, s);
			return (a = l.diffed) && a(t), 128 & t.__u ? void 0 : f;
		}
		function V(n) {
			n && (n.__c && (n.__c.__e = !0), n.__k && n.__k.some(V));
		}
		function q(n, t, u) {
			for (var r = 0; r < u.length; r++) E(u[r], u[++r], u[++r]);
			l.__c && l.__c(t, n), n.some(function(t) {
				try {
					n = t.__h, t.__h = [], n.some(function(n) {
						n.call(t);
					});
				} catch (n) {
					l.__e(n, t.__v);
				}
			});
		}
		function B(n) {
			return "object" != typeof n || null == n || n.__b > 0 ? n : g(n) ? n.map(B) : void 0 !== n.constructor ? null : x({}, n);
		}
		function D(t, u, r, i, o, e, f, c, s) {
			var a, h, p, v, y, w, _, x = r.props || d, b = u.props, k = u.type;
			if ("svg" == k ? o = "http://www.w3.org/2000/svg" : "math" == k ? o = "http://www.w3.org/1998/Math/MathML" : o || (o = "http://www.w3.org/1999/xhtml"), null != e) {
				for (a = 0; a < e.length; a++) if ((y = e[a]) && "setAttribute" in y == !!k && (k ? y.localName == k : 3 == y.nodeType)) {
					t = y, e[a] = null;
					break;
				}
			}
			if (null == t) {
				if (null == k) return document.createTextNode(b);
				t = document.createElementNS(o, k, b.is && b), c && (l.__m && l.__m(u, e), c = !1), e = null;
			}
			if (null == k) x === b || c && t.data == b || (t.data = b);
			else {
				if (e = "textarea" == k && null != b.defaultValue ? null : e && n.call(t.childNodes), !c && null != e) for (x = {}, a = 0; a < t.attributes.length; a++) x[(y = t.attributes[a]).name] = y.value;
				for (a in x) y = x[a], "dangerouslySetInnerHTML" == a ? p = y : "children" == a || a in b || "value" == a && "defaultValue" in b || "checked" == a && "defaultChecked" in b || O(t, a, null, y, o);
				for (a in b) y = b[a], "children" == a ? v = y : "dangerouslySetInnerHTML" == a ? h = y : "value" == a ? w = y : "checked" == a ? _ = y : c && "function" != typeof y || x[a] === y || O(t, a, y, x[a], o);
				if (h) c || p && (h.__html == p.__html || h.__html == t.innerHTML) || (t.innerHTML = h.__html), u.__k = [];
				else if (p && (t.innerHTML = ""), H("template" == u.type ? t.content : t, g(v) ? v : [v], u, r, i, "foreignObject" == k ? "http://www.w3.org/1999/xhtml" : o, e, f, e ? e[0] : r.__k && $(r, 0), c, s), null != e) for (a = e.length; a--;) m(e[a]);
				c && "textarea" != k || (a = "value", "progress" == k && null == w ? t.removeAttribute("value") : null != w && (w !== t[a] || "progress" == k && !w || "option" == k && w != x[a]) && O(t, a, w, x[a], o), a = "checked", null != _ && _ != t[a] && O(t, a, _, x[a], o));
			}
			return t;
		}
		function E(n, t, u) {
			try {
				if ("function" == typeof n) {
					var r = "function" == typeof n.__u;
					r && n.__u(), r && null == t || (n.__u = n(t));
				} else n.current = t;
			} catch (n) {
				l.__e(n, u);
			}
		}
		function G(n, t, u) {
			var r, i;
			if (l.unmount && l.unmount(n), (r = n.ref) && (r.current && r.current != n.__e || E(r, null, t)), null != (r = n.__c)) {
				if (r.componentWillUnmount) try {
					r.componentWillUnmount();
				} catch (n) {
					l.__e(n, t);
				}
				r.base = r.__P = r.__n = null;
			}
			if (r = n.__k) for (i = 0; i < r.length; i++) r[i] && G(r[i], t, u || "function" != typeof n.type);
			u || m(n.__e), n.__c = n.__ = n.__e = void 0;
		}
		function J(n, l, t) {
			return this.constructor(n, t);
		}
		function K(t, u, r) {
			var i, o, e, f;
			u == document && (u = document.documentElement), l.__ && l.__(t, u), o = (i = "function" == typeof r) ? null : r && r.__k || u.__k, e = [], f = [], N(u, t = (!i && r || u).__k = b(M, null, [t]), o || d, d, u.namespaceURI, !i && r ? [r] : o ? null : u.firstChild ? n.call(u.childNodes) : null, e, !i && r ? r : o ? o.__e : u.firstChild, i, f), q(e, t, f), t.props.children = null;
		}
		n = w.slice, l = { __e: function(n, l, t, u) {
			for (var r, i, o; l = l.__;) if ((r = l.__c) && !r.__) try {
				if ((i = r.constructor) && null != i.getDerivedStateFromError && (r.setState(i.getDerivedStateFromError(n)), o = r.__d), null != r.componentDidCatch && (r.componentDidCatch(n, u || {}), o = r.__d), o) return r.__E = r;
			} catch (l) {
				n = l;
			}
			throw n;
		} }, t = 0, u = function(n) {
			return null != n && void 0 === n.constructor;
		}, S.prototype.setState = function(n, l) {
			var t = null != this.__s && this.__s != this.state ? this.__s : this.__s = x({}, this.state);
			"function" == typeof n && (n = n(x({}, t), this.props)), n && x(t, n), null != n && this.__v && (l && this._sb.push(l), P(this));
		}, S.prototype.forceUpdate = function(n) {
			this.__v && (this.__e = !0, n && this.__h.push(n), P(this));
		}, S.prototype.render = M, r = [], o = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = function(n, l) {
			return n.__v.__b - l.__v.__b;
		}, A.__r = 0, f = Math.random().toString(8), c = "__d" + f, s = "__a" + f, a = /(PointerCapture)$|Capture$/i, h = 0, p = z(!1), v = z(!0), y = 0, exports.Component = S, exports.Fragment = M, exports.cloneElement = function(l, t, u) {
			var r, i, o, e, f = x({}, l.props);
			for (o in l.type && l.type.defaultProps && (e = l.type.defaultProps), t) "key" == o ? r = t[o] : "ref" == o ? i = t[o] : f[o] = void 0 === t[o] && null != e ? e[o] : t[o];
			return arguments.length > 2 && (f.children = arguments.length > 3 ? n.call(arguments, 2) : u), k(l.type, f, r || l.key, i || l.ref, null);
		}, exports.createContext = function(n) {
			function l(n) {
				var t, u;
				return this.getChildContext || (t = /* @__PURE__ */ new Set(), (u = {})[l.__c] = this, this.getChildContext = function() {
					return u;
				}, this.componentWillUnmount = function() {
					t = null;
				}, this.shouldComponentUpdate = function(n) {
					this.props.value != n.value && t.forEach(function(n) {
						n.__e = !0, P(n);
					});
				}, this.sub = function(n) {
					t.add(n);
					var l = n.componentWillUnmount;
					n.componentWillUnmount = function() {
						t && t.delete(n), l && l.call(n);
					};
				}), n.children;
			}
			return l.__c = "__cC" + y++, l.__ = n, l.Provider = l.__l = (l.Consumer = function(n, l) {
				return n.children(l);
			}).contextType = l, l;
		}, exports.createElement = b, exports.createRef = function() {
			return { current: null };
		}, exports.h = b, exports.hydrate = function n(l, t) {
			K(l, t, n);
		}, exports.isValidElement = u, exports.options = l, exports.render = K, exports.toChildArray = function n(l, t) {
			return t = t || [], null == l || "boolean" == typeof l || (g(l) ? l.some(function(l) {
				n(l, t);
			}) : t.push(l)), t;
		};
	}));
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/account-i18n.ts
	var import_preact = require_preact();
	const locales = [
		"en",
		"pt-BR",
		"es",
		"fr",
		"de",
		"it",
		"ja",
		"ko",
		"zh-CN",
		"ar"
	];
	const rows = {
		menu: [
			"Account menu",
			"Menu da conta",
			"Menú de la cuenta",
			"Menu du compte",
			"Kontomenü",
			"Menu account",
			"アカウントメニュー",
			"계정 메뉴",
			"账户菜单",
			"قائمة الحساب"
		],
		menuAccount: [
			"Account",
			"Conta",
			"Cuenta",
			"Compte",
			"Konto",
			"Account",
			"アカウント",
			"계정",
			"账户",
			"الحساب"
		],
		menuUsage: [
			"Usage",
			"Uso",
			"Uso",
			"Utilisation",
			"Nutzung",
			"Utilizzo",
			"使用状況",
			"사용량",
			"用量",
			"الاستخدام"
		],
		menuSettings: [
			"Settings",
			"Configurações",
			"Configuración",
			"Paramètres",
			"Einstellungen",
			"Impostazioni",
			"設定",
			"설정",
			"设置",
			"الإعدادات"
		],
		menuHelp: [
			"Help",
			"Ajuda",
			"Ayuda",
			"Aide",
			"Hilfe",
			"Aiuto",
			"ヘルプ",
			"도움말",
			"帮助",
			"المساعدة"
		],
		menuInvite: [
			"Invite a friend",
			"Convidar um amigo",
			"Invitar a un amigo",
			"Inviter un ami",
			"Freund einladen",
			"Invita un amico",
			"友達を招待",
			"친구 초대",
			"邀请朋友",
			"دعوة صديق"
		],
		inviteCopied: [
			"Link copied. Share it with a friend.",
			"Link copiado. Compartilhe com um amigo.",
			"Enlace copiado. Compártelo con un amigo.",
			"Lien copié. Partagez-le avec un ami.",
			"Link kopiert. Teile ihn mit einem Freund.",
			"Link copiato. Condividilo con un amico.",
			"リンクをコピーしました。友達に共有してください。",
			"링크를 복사했습니다. 친구와 공유하세요.",
			"链接已复制。分享给朋友吧。",
			"تم نسخ الرابط. شاركه مع صديق."
		],
		inviteShared: [
			"Link shared.",
			"Link compartilhado.",
			"Enlace compartido.",
			"Lien partagé.",
			"Link geteilt.",
			"Link condiviso.",
			"リンクを共有しました。",
			"링크를 공유했습니다.",
			"链接已分享。",
			"تمت مشاركة الرابط."
		],
		inviteManual: [
			"Select the link and copy it.",
			"Selecione o link e copie.",
			"Selecciona el enlace y cópialo.",
			"Sélectionnez le lien et copiez-le.",
			"Wähle den Link aus und kopiere ihn.",
			"Seleziona il link e copialo.",
			"リンクを選択してコピーしてください。",
			"링크를 선택해서 복사하세요.",
			"选择链接并复制。",
			"حدد الرابط وانسخه."
		],
		inviteLink: [
			"Invitation link",
			"Link do convite",
			"Enlace de invitación",
			"Lien d’invitation",
			"Einladungslink",
			"Link di invito",
			"招待リンク",
			"초대 링크",
			"邀请链接",
			"رابط الدعوة"
		],
		avatarSignIn: [
			"Sign in to Uptokey",
			"Entrar no Uptokey",
			"Iniciar sesión en Uptokey",
			"Se connecter à Uptokey",
			"Bei Uptokey anmelden",
			"Accedi a Uptokey",
			"Uptokeyにログイン",
			"Uptokey에 로그인",
			"登录 Uptokey",
			"تسجيل الدخول إلى Uptokey"
		],
		title: [
			"Uptokey account",
			"Conta Uptokey",
			"Cuenta Uptokey",
			"Compte Uptokey",
			"Uptokey-Konto",
			"Account Uptokey",
			"Uptokeyアカウント",
			"Uptokey 계정",
			"Uptokey 账户",
			"حساب Uptokey"
		],
		optional: [
			"Sign-in is optional for local work and your own API keys.",
			"Entrar é opcional para o trabalho local e suas próprias chaves de API.",
			"Iniciar sesión es opcional para el trabajo local y tus propias claves API.",
			"La connexion est facultative pour le travail local et vos propres clés API.",
			"Für lokale Arbeit und eigene API-Schlüssel ist die Anmeldung optional.",
			"L’accesso è facoltativo per il lavoro locale e le tue chiavi API.",
			"ローカル作業と自分のAPIキーにはログイン不要です。",
			"로컬 작업과 개인 API 키 사용에는 로그인이 필요하지 않습니다.",
			"本地工作和使用自己的 API 密钥无需登录。",
			"تسجيل الدخول اختياري للعمل المحلي ومفاتيح API الخاصة بك."
		],
		notChecked: [
			"Not checked",
			"Não consultada",
			"Sin consultar",
			"Non consulté",
			"Nicht abgefragt",
			"Non consultato",
			"未確認",
			"확인하지 않음",
			"未查询",
			"لم يُتحقق منه"
		],
		loading: [
			"Checking…",
			"Consultando…",
			"Consultando…",
			"Vérification…",
			"Wird geprüft…",
			"Verifica…",
			"確認中…",
			"확인 중…",
			"正在检查…",
			"جارٍ التحقق…"
		],
		connected: [
			"Passkey connected",
			"Passkey conectada",
			"Passkey conectada",
			"Passkey connectée",
			"Passkey verbunden",
			"Passkey connessa",
			"パスキー接続済み",
			"패스키 연결됨",
			"通行密钥已连接",
			"مفتاح المرور متصل"
		],
		signedOut: [
			"Signed out",
			"Sessão desconectada",
			"Sesión cerrada",
			"Déconnecté",
			"Abgemeldet",
			"Disconnesso",
			"未ログイン",
			"로그아웃됨",
			"未登录",
			"تم تسجيل الخروج"
		],
		reconnectAccount: [
			"Sign in again.",
			"Entre novamente.",
			"Inicia sesión de nuevo.",
			"Reconnectez-vous.",
			"Melde dich erneut an.",
			"Accedi di nuovo.",
			"再度ログインしてください。",
			"다시 로그인하세요.",
			"请重新登录。",
			"سجّل الدخول مجددًا."
		],
		recognized: [
			"Account linked",
			"Conta vinculada",
			"Cuenta vinculada",
			"Compte lié",
			"Konto verknüpft",
			"Account collegato",
			"アカウント連携済み",
			"계정 연결됨",
			"账户已关联",
			"الحساب مرتبط"
		],
		linkRequired: [
			"Account requires linking",
			"Conta aguarda vínculo",
			"La cuenta necesita vincularse",
			"Le compte doit être lié",
			"Konto muss verknüpft werden",
			"L’account richiede il collegamento",
			"アカウントの連携が必要です",
			"계정 연결이 필요함",
			"账户需要关联",
			"يلزم ربط الحساب"
		],
		unconfigured: [
			"Sign-in is not available here.",
			"A entrada não está disponível aqui.",
			"El inicio de sesión no está disponible aquí.",
			"La connexion n’est pas disponible ici.",
			"Die Anmeldung ist hier nicht verfügbar.",
			"L’accesso non è disponibile qui.",
			"ここではログインを利用できません。",
			"여기서는 로그인을 사용할 수 없습니다.",
			"此处暂不能登录。",
			"تسجيل الدخول غير متاح هنا."
		],
		unavailable: [
			"Account unavailable. Try again.",
			"Conta indisponível. Tente novamente.",
			"Cuenta no disponible. Inténtalo de nuevo.",
			"Compte indisponible. Réessayez.",
			"Konto nicht verfügbar. Versuche es erneut.",
			"Account non disponibile. Riprova.",
			"アカウントを利用できません。再試行してください。",
			"계정을 사용할 수 없습니다. 다시 시도하세요.",
			"账户不可用。请重试。",
			"الحساب غير متاح. أعد المحاولة."
		],
		connect: [
			"Connect passkey",
			"Conectar passkey",
			"Conectar passkey",
			"Connecter une passkey",
			"Passkey verbinden",
			"Connetti passkey",
			"パスキーを接続",
			"패스키 연결",
			"连接通行密钥",
			"توصيل مفتاح المرور"
		],
		disconnect: [
			"Disconnect device",
			"Desconectar dispositivo",
			"Desconectar dispositivo",
			"Déconnecter l’appareil",
			"Gerät trennen",
			"Disconnetti dispositivo",
			"端末を切断",
			"기기 연결 해제",
			"断开设备",
			"فصل الجهاز"
		],
		refresh: [
			"Refresh",
			"Atualizar",
			"Actualizar",
			"Actualiser",
			"Aktualisieren",
			"Aggiorna",
			"更新",
			"새로고침",
			"刷新",
			"تحديث"
		],
		signIn: [
			"Sign in",
			"Entrar",
			"Iniciar sesión",
			"Se connecter",
			"Anmelden",
			"Accedi",
			"ログイン",
			"로그인",
			"登录",
			"تسجيل الدخول"
		],
		useComputer: [
			"Use account on this computer",
			"Usar conta neste computador",
			"Usar cuenta en este equipo",
			"Utiliser un compte sur cet ordinateur",
			"Konto auf diesem Computer verwenden",
			"Usa un account su questo computer",
			"このコンピューターのアカウントを使う",
			"이 컴퓨터의 계정 사용",
			"使用此电脑上的账户",
			"استخدام حساب على هذا الكمبيوتر"
		],
		shareWaiting: [
			"Approve this code in signed-in Uptokey.",
			"Aprove este código no Uptokey conectado.",
			"Aprueba este código en Uptokey con la sesión iniciada.",
			"Approuvez ce code dans Uptokey connecté.",
			"Bestätige diesen Code im angemeldeten Uptokey.",
			"Approva questo codice in Uptokey con accesso effettuato.",
			"ログイン済みのUptokeyでこのコードを承認してください。",
			"로그인한 Uptokey에서 이 코드를 승인하세요.",
			"请在已登录的 Uptokey 中批准此代码。",
			"وافق على هذا الرمز في Uptokey المسجل الدخول."
		],
		approveAccount: [
			"Approve account access",
			"Aprovar acesso à conta",
			"Aprobar acceso a la cuenta",
			"Approuver l’accès au compte",
			"Kontozugriff bestätigen",
			"Approva l’accesso all’account",
			"アカウントへのアクセスを承認",
			"계정 접근 승인",
			"批准账户访问",
			"الموافقة على الوصول إلى الحساب"
		],
		accountChoice: [
			"Choose account",
			"Escolher conta",
			"Elegir cuenta",
			"Choisir un compte",
			"Konto auswählen",
			"Scegli account",
			"アカウントを選択",
			"계정 선택",
			"选择账户",
			"اختيار الحساب"
		],
		shareExpired: [
			"Code expired. Try again.",
			"Código expirado. Tente novamente.",
			"El código caducó. Inténtalo de nuevo.",
			"Code expiré. Réessayez.",
			"Code abgelaufen. Versuche es erneut.",
			"Codice scaduto. Riprova.",
			"コードの有効期限が切れました。再試行してください。",
			"코드가 만료되었습니다. 다시 시도하세요.",
			"代码已过期。请重试。",
			"انتهت صلاحية الرمز. أعد المحاولة."
		],
		shareDenied: [
			"Account access was not approved. Try again.",
			"O acesso à conta não foi aprovado. Tente novamente.",
			"No se aprobó el acceso a la cuenta. Inténtalo de nuevo.",
			"L’accès au compte n’a pas été approuvé. Réessayez.",
			"Kontozugriff wurde nicht bestätigt. Versuche es erneut.",
			"L’accesso all’account non è stato approvato. Riprova.",
			"アカウントへのアクセスが承認されませんでした。再試行してください。",
			"계정 접근이 승인되지 않았습니다. 다시 시도하세요.",
			"账户访问未获批准。请重试。",
			"لم تتم الموافقة على الوصول إلى الحساب. أعد المحاولة."
		],
		shareConflict: [
			"Account changed. Refresh and choose again.",
			"A conta mudou. Atualize e escolha novamente.",
			"La cuenta cambió. Actualiza y elige de nuevo.",
			"Le compte a changé. Actualisez et choisissez à nouveau.",
			"Konto geändert. Aktualisiere und wähle erneut.",
			"L’account è cambiato. Aggiorna e scegli di nuovo.",
			"アカウントが変更されました。更新して選び直してください。",
			"계정이 변경되었습니다. 새로고침 후 다시 선택하세요.",
			"账户已更改。请刷新后重新选择。",
			"تغير الحساب. حدّث واختر مجددًا."
		],
		disconnectClient: [
			"Disconnect this client",
			"Desconectar este cliente",
			"Desconectar este cliente",
			"Déconnecter ce client",
			"Diesen Client trennen",
			"Disconnetti questo client",
			"このクライアントを切断",
			"이 클라이언트 연결 해제",
			"断开此客户端",
			"فصل هذا العميل"
		],
		endAccount: [
			"Sign out of Uptokey",
			"Sair da conta Uptokey",
			"Cerrar sesión en Uptokey",
			"Se déconnecter d’Uptokey",
			"Bei Uptokey abmelden",
			"Esci da Uptokey",
			"Uptokeyからログアウト",
			"Uptokey에서 로그아웃",
			"退出 Uptokey",
			"تسجيل الخروج من Uptokey"
		],
		accountConnected: [
			"Signed in",
			"Conectado",
			"Sesión iniciada",
			"Connecté",
			"Angemeldet",
			"Accesso effettuato",
			"ログイン済み",
			"로그인됨",
			"已登录",
			"تم تسجيل الدخول"
		],
		freePlan: [
			"Free",
			"Gratuito",
			"Gratis",
			"Gratuit",
			"Kostenlos",
			"Gratuito",
			"無料",
			"무료",
			"免费",
			"مجاني"
		],
		cloudBalance: [
			"Uptokey credits",
			"Créditos Uptokey",
			"Créditos Uptokey",
			"Crédits Uptokey",
			"Uptokey-Guthaben",
			"Crediti Uptokey",
			"Uptokeyクレジット",
			"Uptokey 크레딧",
			"Uptokey 额度",
			"أرصدة Uptokey"
		],
		balanceAvailable: [
			"Available",
			"Disponível",
			"Disponible",
			"Disponible",
			"Verfügbar",
			"Disponibile",
			"利用可能",
			"사용 가능",
			"可用",
			"متاح"
		],
		balanceReserved: [
			"Reserved",
			"Reservado",
			"Reservado",
			"Réservé",
			"Reserviert",
			"Riservato",
			"予約済み",
			"예약됨",
			"已预留",
			"محجوز"
		],
		balanceSpent: [
			"Used",
			"Utilizado",
			"Utilizado",
			"Utilisé",
			"Verbraucht",
			"Utilizzato",
			"使用済み",
			"사용됨",
			"已使用",
			"مستخدم"
		],
		balanceMeasured: [
			"Checked",
			"Conferido",
			"Comprobado",
			"Vérifié",
			"Geprüft",
			"Verificato",
			"確認日時",
			"확인됨",
			"核对时间",
			"تم التحقق"
		],
		balanceUnconfigured: [
			"Credits are not configured.",
			"Créditos não configurados.",
			"Créditos sin configurar.",
			"Crédits non configurés.",
			"Guthaben nicht eingerichtet.",
			"Crediti non configurati.",
			"クレジット未設定。",
			"크레딧이 설정되지 않았습니다.",
			"尚未配置额度。",
			"الأرصدة غير مهيأة."
		],
		balanceLinkRequired: [
			"Credits are not active for this account.",
			"Créditos ainda não ativos nesta conta.",
			"Los créditos no están activos en esta cuenta.",
			"Les crédits ne sont pas actifs pour ce compte.",
			"Guthaben für dieses Konto noch nicht aktiviert.",
			"Crediti non ancora attivi per questo account.",
			"このアカウントのクレジットはまだ有効ではありません。",
			"이 계정의 크레딧이 아직 활성화되지 않았습니다.",
			"此账户的额度尚未启用。",
			"الأرصدة غير مفعلة لهذا الحساب."
		],
		balanceUnavailable: [
			"Balance unavailable. Try again.",
			"Saldo indisponível. Tente novamente.",
			"Saldo no disponible. Inténtalo de nuevo.",
			"Solde indisponible. Réessayez.",
			"Guthaben nicht verfügbar. Versuche es erneut.",
			"Saldo non disponibile. Riprova.",
			"残高を取得できません。再試行してください。",
			"잔액을 확인할 수 없습니다. 다시 시도하세요.",
			"余额不可用。请重试。",
			"الرصيد غير متاح. أعد المحاولة."
		],
		signOut: [
			"Sign out",
			"Sair",
			"Cerrar sesión",
			"Se déconnecter",
			"Abmelden",
			"Esci",
			"ログアウト",
			"로그아웃",
			"退出",
			"تسجيل الخروج"
		],
		deviceBinding: [
			"Advanced: device binding",
			"Avançado: vínculo do dispositivo",
			"Avanzado: vinculación del dispositivo",
			"Avancé : liaison de l’appareil",
			"Erweitert: Geräteverknüpfung",
			"Avanzate: collegamento del dispositivo",
			"詳細設定：端末の連携",
			"고급: 기기 연결",
			"高级：设备关联",
			"خيارات متقدمة: ربط الجهاز"
		],
		connecting: [
			"Complete sign-in in your browser.",
			"Conclua a entrada no navegador.",
			"Completa el inicio de sesión en tu navegador.",
			"Terminez la connexion dans votre navigateur.",
			"Schließe die Anmeldung im Browser ab.",
			"Completa l’accesso nel browser.",
			"ブラウザーでログインを完了してください。",
			"브라우저에서 로그인을 완료하세요.",
			"请在浏览器中完成登录。",
			"أكمل تسجيل الدخول في المتصفح."
		],
		browserConfirm: [
			"Connect this Uptokey app only if this code matches the code shown in the app.",
			"Conecte este aplicativo Uptokey somente se o código corresponder ao exibido nele.",
			"Conecta esta aplicación Uptokey solo si el código coincide con el de la aplicación.",
			"Connectez cette application Uptokey seulement si le code correspond à celui affiché dans l’application.",
			"Verbinde diese Uptokey-App nur, wenn der Code mit dem in der App angezeigten Code übereinstimmt.",
			"Collega questa app Uptokey solo se il codice corrisponde a quello mostrato nell’app.",
			"このコードがアプリに表示されたコードと一致する場合のみ、Uptokeyアプリを接続してください。",
			"이 코드가 앱에 표시된 코드와 일치할 때만 Uptokey 앱을 연결하세요.",
			"仅当此代码与应用中显示的代码一致时，才连接此 Uptokey 应用。",
			"اربط تطبيق Uptokey هذا فقط إذا تطابق الرمز مع الرمز المعروض في التطبيق."
		],
		browserApprove: [
			"Connect Uptokey app",
			"Conectar aplicativo Uptokey",
			"Conectar aplicación Uptokey",
			"Connecter l’application Uptokey",
			"Uptokey-App verbinden",
			"Collega l’app Uptokey",
			"Uptokeyアプリを接続",
			"Uptokey 앱 연결",
			"连接 Uptokey 应用",
			"ربط تطبيق Uptokey"
		],
		browserComplete: [
			"Connection approved. You can close this tab.",
			"Conexão aprovada. Você pode fechar esta aba.",
			"Conexión aprobada. Puedes cerrar esta pestaña.",
			"Connexion approuvée. Vous pouvez fermer cet onglet.",
			"Verbindung genehmigt. Du kannst diesen Tab schließen.",
			"Collegamento approvato. Puoi chiudere questa scheda.",
			"接続を承認しました。このタブを閉じてください。",
			"연결이 승인되었습니다. 이 탭을 닫아도 됩니다.",
			"连接已批准。可以关闭此标签页。",
			"تمت الموافقة على الاتصال. يمكنك إغلاق علامة التبويب هذه."
		],
		browserReturnTitle: [
			"Return to Uptokey",
			"Volte ao Uptokey",
			"Vuelve a Uptokey",
			"Revenez dans Uptokey",
			"Zurück zu Uptokey",
			"Torna a Uptokey",
			"Uptokeyに戻る",
			"Uptokey로 돌아가기",
			"返回 Uptokey",
			"ارجع إلى Uptokey"
		],
		browserCodeLabel: [
			"Confirmation code",
			"Código de confirmação",
			"Código de confirmación",
			"Code de confirmation",
			"Bestätigungscode",
			"Codice di conferma",
			"確認コード",
			"확인 코드",
			"确认码",
			"رمز التأكيد"
		],
		browserPairConfirm: [
			"Use this browser’s AI access in your Uptokey terminal. This does not grant access to files.",
			"Use o acesso à IA deste navegador no terminal Uptokey. Isso não autoriza acesso a arquivos.",
			"Usa el acceso a IA de este navegador en tu terminal Uptokey. No permite acceder a archivos.",
			"Utilisez l’accès IA de ce navigateur dans le terminal Uptokey. Aucun accès aux fichiers n’est accordé.",
			"Nutze den KI-Zugang dieses Browsers im Uptokey-Terminal. Dateien werden nicht freigegeben.",
			"Usa l’accesso IA di questo browser nel terminale Uptokey. Non autorizza l’accesso ai file.",
			"このブラウザーのAIアクセスをUptokeyターミナルで使います。ファイルへのアクセスは許可しません。",
			"이 브라우저의 AI 접근을 Uptokey 터미널에서 사용합니다. 파일 접근은 허용하지 않습니다.",
			"在 Uptokey 终端中使用此浏览器的 AI 访问权限。这不会授予文件访问权限。",
			"استخدم وصول الذكاء الاصطناعي لهذا المتصفح في طرفية Uptokey. لا يمنح هذا وصولًا إلى الملفات."
		],
		browserPairAction: [
			"Connect this terminal",
			"Conectar este terminal",
			"Conectar este terminal",
			"Connecter ce terminal",
			"Dieses Terminal verbinden",
			"Collega questo terminale",
			"このターミナルを接続",
			"이 터미널 연결",
			"连接此终端",
			"ربط هذه الطرفية"
		],
		browserPairMissing: [
			"Open this link in the browser where you already use Uptokey AI.",
			"Abra este link no navegador em que você já usa a IA Uptokey.",
			"Abre este enlace en el navegador donde ya usas la IA Uptokey.",
			"Ouvrez ce lien dans le navigateur où vous utilisez déjà l’IA Uptokey.",
			"Öffne diesen Link im Browser, in dem du Uptokey-KI bereits nutzt.",
			"Apri questo link nel browser in cui usi già l’IA Uptokey.",
			"Uptokey AIを使用しているブラウザーでこのリンクを開いてください。",
			"Uptokey AI를 이미 사용하는 브라우저에서 이 링크를 여세요.",
			"请在已使用 Uptokey AI 的浏览器中打开此链接。",
			"افتح هذا الرابط في المتصفح الذي تستخدم فيه ذكاء Uptokey الاصطناعي بالفعل."
		],
		browserPairConflict: [
			"This browser’s AI access is connected to another installation.",
			"O acesso à IA deste navegador está conectado a outra instalação.",
			"El acceso a IA de este navegador está conectado a otra instalación.",
			"L’accès IA de ce navigateur est connecté à une autre installation.",
			"Der KI-Zugang dieses Browsers ist mit einer anderen Installation verbunden.",
			"L’accesso IA di questo browser è collegato a un’altra installazione.",
			"このブラウザーのAIアクセスは別のインストールに接続されています。",
			"이 브라우저의 AI 접근은 다른 설치에 연결되어 있습니다.",
			"此浏览器的 AI 访问权限已连接到另一安装。",
			"وصول الذكاء الاصطناعي لهذا المتصفح مرتبط بتثبيت آخر."
		],
		browserLinkExpired: [
			"This sign-in link has expired.",
			"Este link de acesso expirou.",
			"Este enlace de inicio de sesión ha caducado.",
			"Ce lien de connexion a expiré.",
			"Dieser Anmeldelink ist abgelaufen.",
			"Questo link di accesso è scaduto.",
			"このログインリンクの有効期限が切れました。",
			"이 로그인 링크가 만료되었습니다.",
			"此登录链接已过期。",
			"انتهت صلاحية رابط تسجيل الدخول."
		],
		browserRestart: [
			"Return to the Uptokey terminal. Open Account → Sign in for a new link.",
			"Volte ao terminal Uptokey. Abra Conta → Entrar para obter um novo link.",
			"Vuelve al terminal Uptokey. Abre Cuenta → Iniciar sesión para obtener un enlace nuevo.",
			"Revenez au terminal Uptokey. Ouvrez Compte → Se connecter pour obtenir un nouveau lien.",
			"Kehre zum Uptokey-Terminal zurück. Öffne Konto → Anmelden, um einen neuen Link zu erhalten.",
			"Torna al terminale Uptokey. Apri Account → Accedi per ottenere un nuovo link.",
			"Uptokey のターミナルに戻り、アカウント → ログインから新しいリンクを取得してください。",
			"Uptokey 터미널로 돌아가 계정 → 로그인을 선택하여 새 링크를 받으세요.",
			"返回 Uptokey 终端，打开账户 → 登录以获取新链接。",
			"ارجع إلى طرفية Uptokey. افتح الحساب ← تسجيل الدخول للحصول على رابط جديد."
		],
		link: [
			"Link device",
			"Vincular dispositivo",
			"Vincular dispositivo",
			"Lier l’appareil",
			"Gerät verknüpfen",
			"Collega dispositivo",
			"端末を連携",
			"기기 연결",
			"关联设备",
			"ربط الجهاز"
		],
		confirmPrompt: [
			"Link this device to the signed-in account?",
			"Vincular este dispositivo à conta conectada?",
			"¿Vincular este dispositivo a la cuenta conectada?",
			"Lier cet appareil au compte connecté ?",
			"Dieses Gerät mit dem angemeldeten Konto verknüpfen?",
			"Collegare questo dispositivo all’account connesso?",
			"この端末をログイン中のアカウントと連携しますか？",
			"이 기기를 로그인한 계정에 연결할까요?",
			"将此设备关联到已登录的账户？",
			"هل تريد ربط هذا الجهاز بالحساب المسجل الدخول؟"
		],
		confirm: [
			"Confirm link",
			"Confirmar vínculo",
			"Confirmar vínculo",
			"Confirmer le lien",
			"Verknüpfung bestätigen",
			"Conferma collegamento",
			"連携を確定",
			"연결 확인",
			"确认关联",
			"تأكيد الربط"
		],
		cancel: [
			"Cancel",
			"Cancelar",
			"Cancelar",
			"Annuler",
			"Abbrechen",
			"Annulla",
			"キャンセル",
			"취소",
			"取消",
			"إلغاء"
		],
		cancelled: [
			"Cancelled. Nothing changed.",
			"Cancelado. Nada foi alterado.",
			"Cancelado. No se cambió nada.",
			"Annulé. Aucun changement.",
			"Abgebrochen. Nichts wurde geändert.",
			"Annullato. Nessuna modifica.",
			"キャンセルしました。変更はありません。",
			"취소되었습니다. 변경된 사항이 없습니다.",
			"已取消。未做任何更改。",
			"تم الإلغاء. لم يتغير شيء."
		],
		localOrigin: [
			"Open compatible local address",
			"Abrir endereço local compatível",
			"Abrir dirección local compatible",
			"Ouvrir l’adresse locale compatible",
			"Kompatible lokale Adresse öffnen",
			"Apri indirizzo locale compatibile",
			"対応するローカルアドレスを開く",
			"호환되는 로컬 주소 열기",
			"打开兼容的本地地址",
			"فتح عنوان محلي متوافق"
		],
		originHint: [
			"This passkey requires localhost. Open the compatible address to continue.",
			"Esta passkey exige localhost. Abra o endereço compatível para continuar.",
			"Esta passkey requiere localhost. Abre la dirección compatible para continuar.",
			"Cette passkey nécessite localhost. Ouvrez l’adresse compatible pour continuer.",
			"Diese Passkey benötigt localhost. Öffne die kompatible Adresse, um fortzufahren.",
			"Questa passkey richiede localhost. Apri l’indirizzo compatibile per continuare.",
			"このパスキーにはlocalhostが必要です。対応するアドレスを開いて続行してください。",
			"이 패스키에는 localhost가 필요합니다. 호환되는 주소를 열어 계속하세요.",
			"此通行密钥需要localhost。请打开兼容地址继续。",
			"يتطلب مفتاح المرور هذا localhost. افتح العنوان المتوافق للمتابعة."
		],
		technical: [
			"Technical details",
			"Detalhes técnicos",
			"Detalles técnicos",
			"Détails techniques",
			"Technische Details",
			"Dettagli tecnici",
			"技術情報",
			"기술 세부 정보",
			"技术详情",
			"التفاصيل التقنية"
		],
		unknown: [
			"Status unavailable",
			"Estado indisponível",
			"Estado no disponible",
			"État indisponible",
			"Status nicht verfügbar",
			"Stato non disponibile",
			"状態を取得できません",
			"상태를 확인할 수 없음",
			"状态不可用",
			"الحالة غير متاحة"
		],
		rejected: [
			"Authentication was not confirmed. Try again.",
			"A autenticação não foi confirmada. Tente novamente.",
			"No se confirmó la autenticación. Inténtalo de nuevo.",
			"L’authentification n’a pas été confirmée. Réessayez.",
			"Die Anmeldung wurde nicht bestätigt. Versuche es erneut.",
			"L’autenticazione non è stata confermata. Riprova.",
			"認証を確認できませんでした。再試行してください。",
			"인증이 확인되지 않았습니다. 다시 시도하세요.",
			"未能确认身份验证。请重试。",
			"لم يتم تأكيد المصادقة. أعد المحاولة."
		],
		disconnectFailed: [
			"Device disconnection was not confirmed. Check the account before trying again.",
			"A desconexão do dispositivo não foi confirmada. Consulte a conta antes de tentar novamente.",
			"No se confirmó la desconexión del dispositivo. Consulta la cuenta antes de reintentar.",
			"La déconnexion de l’appareil n’a pas été confirmée. Vérifiez le compte avant de réessayer.",
			"Die Gerätetrennung wurde nicht bestätigt. Prüfe das Konto vor einem erneuten Versuch.",
			"La disconnessione non è stata confermata. Verifica l’account prima di riprovare.",
			"端末の切断を確認できませんでした。再試行の前にアカウントを確認してください。",
			"기기 연결 해제가 확인되지 않았습니다. 다시 시도하기 전에 계정을 확인하세요.",
			"未能确认设备已断开。重试前请查询账户。",
			"لم يتم تأكيد فصل الجهاز. تحقق من الحساب قبل إعادة المحاولة."
		],
		linkFailed: [
			"Device linking was not confirmed. Check the account before trying again.",
			"O vínculo do dispositivo não foi confirmado. Consulte a conta antes de tentar novamente.",
			"No se confirmó el vínculo del dispositivo. Consulta la cuenta antes de reintentar.",
			"Le lien de l’appareil n’a pas été confirmé. Vérifiez le compte avant de réessayer.",
			"Die Geräteverknüpfung wurde nicht bestätigt. Prüfe das Konto vor einem erneuten Versuch.",
			"Il collegamento non è stato confermato. Verifica l’account prima di riprovare.",
			"端末の連携を確認できませんでした。再試行の前にアカウントを確認してください。",
			"기기 연결이 확인되지 않았습니다. 다시 시도하기 전에 계정을 확인하세요.",
			"未能确认设备关联。重试前请查询账户。",
			"لم يتم تأكيد ربط الجهاز. تحقق من الحساب قبل إعادة المحاولة."
		]
	};
	function accountLabel(lang, key) {
		const index = locales.indexOf(lang);
		return rows[key][index < 0 ? 0 : index];
	}
	const accountLocales = locales;
	Object.keys(rows);
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/deadline.ts
	function createDeadline(milliseconds) {
		if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error("deadline_invalid");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("deadline_exceeded")), milliseconds);
		return {
			signal: controller.signal,
			clear: () => clearTimeout(timer)
		};
	}
	var init_deadline = __esmMin((() => {}));
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/same-origin-client.ts
	function sameOriginFetch(path, init = {}, fetchImpl = fetch, timeoutMs = SAME_ORIGIN_TIMEOUT_MS) {
		assertApiPath(path);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3e4) throw new Error("same_origin_timeout_invalid");
		const deadline = createDeadline(timeoutMs);
		const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
		try {
			return fetchImpl(path, {
				...init,
				redirect: "error",
				signal
			}).catch(() => {
				throw sameOriginTransportError(init.signal, deadline.signal);
			}).finally(deadline.clear);
		} catch {
			deadline.clear();
			return Promise.reject(sameOriginTransportError(init.signal, deadline.signal));
		}
	}
	function sameOriginTransportError(caller, deadline) {
		return /* @__PURE__ */ new Error(caller?.aborted ? "same_origin_cancelled" : deadline.aborted ? "same_origin_timeout" : "same_origin_unavailable");
	}
	function assertApiPath(path) {
		let parsed;
		try {
			parsed = new URL(path, SYNTHETIC_ORIGIN);
		} catch {
			throw new Error("same_origin_path_invalid");
		}
		if (!path.startsWith("/api/") || path.startsWith("//") || parsed.origin !== SYNTHETIC_ORIGIN || parsed.search || parsed.hash || `${parsed.pathname}` !== path) throw new Error("same_origin_path_invalid");
	}
	var SAME_ORIGIN_TIMEOUT_MS, SYNTHETIC_ORIGIN;
	var init_same_origin_client = __esmMin((() => {
		init_deadline();
		SAME_ORIGIN_TIMEOUT_MS = 1e4;
		SYNTHETIC_ORIGIN = "https://dashboard.uptokey.invalid";
	}));
	//#endregion
	//#region proxy/contratos/canonical.js
	function canonicalJson(value) {
		return canonicalValue(value, 0, /* @__PURE__ */ new Set(), { remaining: 1048576 });
	}
	function canonicalValue(value, depth, seen, budget) {
		if (depth > 32 || value === void 0 || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("sync_non_json_value");
		if (value === null || typeof value !== "object") {
			if (typeof value === "number" && !Number.isFinite(value)) throw new Error("sync_non_json_value");
			if (typeof value === "string" && value.length + 2 > budget.remaining) throw new Error("sync_non_json_value");
			return charge(JSON.stringify(value), budget);
		}
		if (seen.has(value)) throw new Error("sync_non_json_value");
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("sync_non_json_value");
				if (value.length > 1024) throw new Error("sync_non_json_value");
				const ownKeys = Reflect.ownKeys(value);
				const keys = Object.keys(value);
				if (ownKeys.length !== value.length + 1 || ownKeys[ownKeys.length - 1] !== "length" || keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error("sync_non_json_value");
				const descriptors = Object.getOwnPropertyDescriptors(value);
				if (keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) throw new Error("sync_non_json_value");
				const parts = [charge("[", budget)];
				keys.forEach((key, index) => {
					if (index) parts.push(charge(",", budget));
					parts.push(canonicalValue(descriptors[key].value, depth + 1, seen, budget));
				});
				parts.push(charge("]", budget));
				return parts.join("");
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) throw new Error("sync_non_json_value");
			const keys = Reflect.ownKeys(value);
			if (keys.length > 256 || keys.some((key) => typeof key !== "string")) throw new Error("sync_non_json_value");
			const descriptors = Object.getOwnPropertyDescriptors(value);
			if (keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) throw new Error("sync_non_json_value");
			const parts = [charge("{", budget)];
			keys.sort().forEach((key, index) => {
				if (key.length + 2 > budget.remaining) throw new Error("sync_non_json_value");
				if (index) parts.push(charge(",", budget));
				parts.push(charge(JSON.stringify(key), budget), charge(":", budget), canonicalValue(descriptors[key].value, depth + 1, seen, budget));
			});
			parts.push(charge("}", budget));
			return parts.join("");
		} finally {
			seen.delete(value);
		}
	}
	function charge(fragment, budget) {
		if (fragment.length > budget.remaining) throw new Error("sync_non_json_value");
		const size = new TextEncoder().encode(fragment).byteLength;
		if (size > budget.remaining) throw new Error("sync_non_json_value");
		budget.remaining -= size;
		return fragment;
	}
	var init_canonical = __esmMin((() => {}));
	//#endregion
	//#region proxy/contratos/plain-data.js
	function isDataRecord(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value"));
	}
	function asDataRecord(value) {
		return isDataRecord(value) ? value : void 0;
	}
	var init_plain_data = __esmMin((() => {}));
	var init_workflow = __esmMin((() => {
		Object.freeze({
			commandBytes: 262144,
			steps: 12,
			entries: 256,
			sources: 256,
			artifactBytes: 5242880,
			videoArtifactBytes: 67108864,
			projectBytes: 104857600,
			activeRunsPerProject: 1,
			activeRunsPerProcess: 2
		});
		Object.freeze([
			"project:read",
			"project:write",
			"project:process:run",
			"plan:create",
			"run:execute",
			"run:cancel",
			"artifact:read",
			"recipe:write"
		]);
		Object.freeze([
			"draft",
			"awaiting_approval",
			"ready",
			"running",
			"succeeded",
			"failed",
			"cancelled",
			"needs_attention"
		]);
		Object.freeze([
			"prepared",
			"dispatched",
			"succeeded",
			"failed",
			"unknown"
		]);
	}));
	//#endregion
	//#region proxy/contratos/limits.js
	async function readBoundedJson(request, maxBytes = MAX_CONFIG_REQUEST_BYTES, timeoutMs = 1e4) {
		return readJson(request, maxBytes, timeoutMs, MAX_INFERENCE_REQUEST_BYTES);
	}
	async function readJson(request, maxBytes, timeoutMs, ceiling) {
		if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
			cancelStream(request.body);
			return {
				ok: false,
				reason: "invalid"
			};
		}
		const body = await readBody(request, maxBytes, timeoutMs, ceiling);
		if (!body.ok) return body;
		try {
			return {
				ok: true,
				value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.value))
			};
		} catch {
			return {
				ok: false,
				reason: "invalid"
			};
		}
	}
	async function readBody(request, maxBytes, timeoutMs, ceiling) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12e4) {
			cancelStream(request?.body);
			return {
				ok: false,
				reason: "invalid"
			};
		}
		const declared = request.headers.get("content-length");
		if (declared !== null) {
			if (!/^\d+$/.test(declared)) {
				cancelStream(request.body);
				return {
					ok: false,
					reason: "invalid"
				};
			}
			if (Number(declared) > maxBytes) {
				cancelStream(request.body);
				return {
					ok: false,
					reason: "too_large"
				};
			}
		}
		if (!request.body) return {
			ok: false,
			reason: "invalid"
		};
		const reader = request.body.getReader();
		const chunks = [];
		let size = 0;
		const deadline = Symbol("bounded_json_timeout");
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve(deadline), timeoutMs);
		});
		try {
			while (true) {
				const part = await Promise.race([reader.read(), timeout]);
				if (part === deadline) {
					cancelStream(reader);
					return {
						ok: false,
						reason: "invalid"
					};
				}
				const { done, value } = part;
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes) {
					cancelStream(reader);
					return {
						ok: false,
						reason: "too_large"
					};
				}
				chunks.push(value);
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return {
				ok: true,
				value: bytes
			};
		} catch {
			cancelStream(reader);
			return {
				ok: false,
				reason: "invalid"
			};
		} finally {
			clearTimeout(timer);
		}
	}
	function cancelStream(stream) {
		try {
			Promise.resolve(stream?.cancel()).catch(() => void 0);
		} catch {}
	}
	var MAX_CONFIG_REQUEST_BYTES, MAX_INFERENCE_REQUEST_BYTES, MAX_CONTROL_RESPONSE_BYTES;
	var init_limits = __esmMin((() => {
		init_workflow();
		MAX_CONFIG_REQUEST_BYTES = 65536;
		MAX_INFERENCE_REQUEST_BYTES = 1048576;
		MAX_CONTROL_RESPONSE_BYTES = 262144;
	}));
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/design-bridge/billing-account.ts
	async function accountFetch(path, init = {}, fetcher = fetch) {
		const headers = new Headers(init.headers);
		if (headers.has("authorization")) throw new AccountServiceError("account_credential_boundary");
		const response = await sameOriginFetch(path, {
			...init,
			headers,
			credentials: "same-origin",
			cache: "no-store"
		}, fetcher);
		if (response.status === 401) throw new AccountServiceError("signed_out");
		if (response.status === 204) return response;
		if (response.status === 404 || !response.headers.get("content-type")?.includes("application/json")) throw new AccountServiceError("unconfigured");
		if (!response.ok) {
			const parsed = await readBoundedJson(response, 4096);
			const raw = parsed.ok && typeof parsed.value === "object" && parsed.value !== null ? parsed.value.error : void 0;
			const code = typeof raw === "string" && /^[a-z0-9_]{1,100}$/.test(raw) ? raw : "account_unavailable";
			throw new AccountServiceError(code === "account_not_configured" ? "unconfigured" : code);
		}
		return response;
	}
	async function requestBillingAccount(path, input, fetcher = fetch) {
		const method = billingMethods[path];
		if (!method || method === "GET" && input !== void 0) throw new AccountServiceError("billing_path_invalid");
		if (typeof window !== "undefined" && path !== "checkout-context") {
			const account = await Promise.resolve().then(() => (init_account_client(), account_client_exports));
			if (account.linkedAccountTransport() && account.publicAccountSnapshot()?.authenticated) {
				const operation = {
					"client-config": "billing.client-config",
					profile: "billing.profile",
					balances: "billing.balances",
					invoices: "billing.invoices",
					"portal-session": "billing.portal"
				}[path];
				if (operation) try {
					const result = await account.requestNativeAccountControl({
						operation,
						payload: {}
					});
					if (result.status < 200 || result.status >= 300) {
						const row = result.body && typeof result.body === "object" && !Array.isArray(result.body) ? result.body : void 0, raw = typeof row?.error === "object" && row.error !== null ? row.error.type : row?.error, code = typeof raw === "string" && /^[a-z0-9_]{1,100}$/.test(raw) ? raw : result.status === 401 ? "signed_out" : "account_unavailable";
						throw new AccountServiceError(code === "account_not_configured" ? "unconfigured" : code);
					}
					return result.body;
				} catch (error) {
					if (error instanceof AccountServiceError) throw error;
					throw new AccountServiceError(error instanceof Error ? error.message : "account_unavailable");
				}
			}
		}
		const parsed = await readBoundedJson(await accountFetch(`/api/billing/${path}`, {
			method,
			...method === "POST" ? {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input ?? {})
			} : {}
		}, fetcher), MAX_CONTROL_RESPONSE_BYTES);
		if (!parsed.ok) throw new AccountServiceError("billing_response_invalid");
		return parsed.value;
	}
	async function getBillingAccount(fetcher = fetch) {
		try {
			return {
				state: "connected",
				profile: await requestBillingAccount("profile", void 0, fetcher)
			};
		} catch (error) {
			if (error instanceof AccountServiceError && (error.code === "signed_out" || error.code === "unconfigured")) return { state: error.code };
			throw error;
		}
	}
	var AccountServiceError, billingMethods;
	var init_billing_account = __esmMin((() => {
		init_same_origin_client();
		init_limits();
		AccountServiceError = class extends Error {
			code;
			constructor(code) {
				super(code);
				this.name = "AccountServiceError";
				this.code = code;
			}
		};
		billingMethods = {
			"client-config": "GET",
			profile: "GET",
			balances: "GET",
			invoices: "GET",
			"portal-session": "POST",
			"checkout-context": "POST"
		};
	}));
	var init_proxy = __esmMin((() => {
		init_limits();
		init_workflow();
		typeof __UPTOKEY_PROXY_URL__ === "string" && __UPTOKEY_PROXY_URL__ && __UPTOKEY_PROXY_URL__;
	}));
	//#endregion
	//#region proxy/contratos/account-native.js
	function invalid$1() {
		throw new Error("account_response_invalid");
	}
	function record(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) invalid$1();
		return value;
	}
	function nowValue(value) {
		const now = value === void 0 ? Date.now() : value;
		if (!Number.isSafeInteger(now) || now < 0) invalid$1();
		return now;
	}
	function trustedOrigin(value) {
		if (value === void 0) return void 0;
		let url;
		try {
			url = new URL(value);
		} catch {
			invalid$1();
		}
		if (url.origin !== value || url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) invalid$1();
		return url.origin;
	}
	function authorizeUrl(value, expectedOrigin) {
		if (typeof value !== "string" || value.length < 1 || value.length > 2048) invalid$1();
		let url;
		try {
			url = new URL(value);
		} catch {
			invalid$1();
		}
		if (url.username || url.password || url.hash || url.pathname !== "/api/account/native/authorize" || url.searchParams.getAll("id").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "id") || !ACCOUNT_ID$1.test(url.searchParams.get("id") ?? "") || url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)) || expectedOrigin !== void 0 && url.origin !== trustedOrigin(expectedOrigin)) invalid$1();
		return url.href;
	}
	function readAccountLoginResponse(value, options = {}) {
		const row = record(value);
		if (row.session !== void 0) {
			if (Object.keys(row).some((key) => key !== "session")) invalid$1();
			return { session: row.session };
		}
		if (Object.keys(row).sort().join(",") !== "expiresAt,loginUrl,userCode" || typeof row.userCode !== "string" || !/^[A-F0-9]{8}$/.test(row.userCode) || !Number.isSafeInteger(row.expiresAt)) invalid$1();
		const now = nowValue(options.now), expiresAt = Number(row.expiresAt);
		if (expiresAt <= now || expiresAt > now + LOGIN_TTL_MS) invalid$1();
		return {
			loginUrl: authorizeUrl(row.loginUrl, options.expectedOrigin),
			userCode: row.userCode,
			expiresAt
		};
	}
	function readAccountConnectionResponse(value, options = {}) {
		const row = record(value);
		if (Object.keys(row).sort().join(",") !== "expiresAt,loginUrl" || !Number.isSafeInteger(row.expiresAt)) invalid$1();
		const expiresAt = Number(row.expiresAt);
		if (expiresAt <= nowValue(options.now)) invalid$1();
		return {
			loginUrl: authorizeUrl(row.loginUrl, options.expectedOrigin),
			expiresAt
		};
	}
	var ACCOUNT_ID$1, LOGIN_TTL_MS, LOOPBACK;
	var init_account_native = __esmMin((() => {
		ACCOUNT_ID$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		LOGIN_TTL_MS = 36e4;
		LOOPBACK = /* @__PURE__ */ new Set([
			"localhost",
			"127.0.0.1",
			"[::1]"
		]);
	}));
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/interaction-effects.ts
	/** Call after a confirmed operation. Never put credentials, user content or response bodies in an event. */
	function publishInteractionEffect(domain, metadata = {}) {
		if (typeof window === "undefined") return;
		const detail = {};
		if (typeof metadata.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(metadata.id)) detail.id = metadata.id;
		if (typeof metadata.revision === "number" && Number.isSafeInteger(metadata.revision) && metadata.revision >= 0) detail.revision = metadata.revision;
		else if (typeof metadata.revision === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(metadata.revision)) detail.revision = metadata.revision;
		window.dispatchEvent(new CustomEvent(interactionEffectGraph[domain].event, { detail: Object.freeze(detail) }));
	}
	/** Refresh from the service on local changes or return from another window; never replay a mutation. */
	function subscribeInteractionRefresh(domains, refresh) {
		if (typeof window === "undefined") return () => {};
		let active = true;
		let pending = false;
		const schedule = () => {
			if (!active || pending) return;
			pending = true;
			queueMicrotask(() => {
				pending = false;
				if (active) refresh();
			});
		};
		const visible = () => {
			if (document.visibilityState === "visible") schedule();
		};
		const events = [...new Set(domains.flatMap((domain) => domain === "account" ? [interactionEffectGraph[domain].event, "uptokey:account-refresh"] : [interactionEffectGraph[domain].event]))];
		for (const event of events) window.addEventListener(event, schedule);
		window.addEventListener("focus", schedule);
		document.addEventListener("visibilitychange", visible);
		return () => {
			active = false;
			for (const event of events) window.removeEventListener(event, schedule);
			window.removeEventListener("focus", schedule);
			document.removeEventListener("visibilitychange", visible);
		};
	}
	var interactionEffectGraph;
	var init_interaction_effects = __esmMin((() => {
		interactionEffectGraph = {
			connections: {
				event: "uptokey-connections-changed",
				authority: "connection-profiles",
				invalidate: [
					"connection-list",
					"model-picker",
					"routing",
					"multimodel",
					"media-profile",
					"model-usage"
				],
				preserve: [
					"endpoint-client-keys",
					"uptokey-account",
					"conversation-history",
					"usage-history"
				]
			},
			routing: {
				event: "uptokey-routing-changed",
				authority: "routing-config",
				invalidate: ["routing", "routing-costs"],
				preserve: ["connection-credentials", "conversation-history"]
			},
			account: {
				event: "uptokey-account-refresh",
				authority: "account-login-service",
				invalidate: [
					"account-state",
					"account-rail",
					"billing",
					"hosted-models"
				],
				preserve: [
					"connection-credentials",
					"local-models",
					"workspace-context",
					"bff-session"
				]
			},
			media: {
				event: "uptokey-media-changed",
				authority: "managed-media",
				invalidate: ["media-profile"],
				preserve: ["conversation-history", "artifact-receipts"]
			},
			context: {
				event: "uptokey-context-refresh",
				authority: "workspace-context",
				invalidate: ["workspace-context", "workspace-manifest"],
				preserve: [
					"account-state",
					"connection-credentials",
					"conversation-history"
				]
			}
		};
	}));
	//#endregion
	//#region proxy/core/src/account-login-protocol.ts
	function accountRecord(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_response_invalid");
		return value;
	}
	function accountRevision(value) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("account_response_invalid");
		return value;
	}
	function readAccountAvailable(value) {
		const row = accountRecord(value), revision = accountRevision(row.revision);
		if (!Array.isArray(row.accounts) || row.accounts.length > 256 || !(row.currentAccountRef === null || typeof row.currentAccountRef === "string" && ACCOUNT_REF.test(row.currentAccountRef)) || !(row.currentOwned === null || typeof row.currentOwned === "boolean") || row.currentAccountRef === null !== (row.currentOwned === null)) throw Error("account_response_invalid");
		const seen = /* @__PURE__ */ new Set();
		const accounts = row.accounts.map((value) => {
			const entry = accountRecord(value), session = readAccountPublicSession(entry.session);
			if (typeof entry.accountRef !== "string" || !ACCOUNT_REF.test(entry.accountRef) || seen.has(entry.accountRef) || typeof entry.owned !== "boolean" || !session.authenticated || typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= 0) throw Error("account_response_invalid");
			seen.add(entry.accountRef);
			return {
				accountRef: entry.accountRef,
				owned: entry.owned,
				session,
				expiresAt: entry.expiresAt
			};
		});
		if (row.currentAccountRef !== null && !accounts.some((entry) => entry.accountRef === row.currentAccountRef && entry.owned === row.currentOwned)) throw Error("account_response_invalid");
		return {
			revision,
			currentAccountRef: row.currentAccountRef,
			currentOwned: row.currentOwned,
			accounts
		};
	}
	function readAccountAdoption(value) {
		const row = accountRecord(value);
		return {
			revision: accountRevision(row.revision),
			session: readAccountPublicSession(row.session)
		};
	}
	function readAccountShareChallenge(value) {
		const row = accountRecord(value);
		if (typeof row.id !== "string" || !ACCOUNT_ID.test(row.id) || typeof row.userCode !== "string" || !/^[A-F0-9]{8}$/.test(row.userCode) || typeof row.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.expiresAt) || !Number.isFinite(Date.parse(row.expiresAt))) throw Error("account_response_invalid");
		return {
			id: row.id,
			userCode: row.userCode,
			expiresAt: row.expiresAt
		};
	}
	function readAccountShareRequests(value) {
		const row = accountRecord(value);
		if (!Array.isArray(row.requests) || row.requests.length > 20) throw Error("account_response_invalid");
		const seen = /* @__PURE__ */ new Set();
		return { requests: row.requests.map((value) => {
			const entry = accountRecord(value), challenge = readAccountShareChallenge(entry);
			if (seen.has(challenge.id) || typeof entry.clientName !== "string" || entry.clientName.length < 1 || entry.clientName.length > 120 || /[\u0000-\u001f\u007f]/.test(entry.clientName) || ![
				"pwa",
				"tauri",
				"tui",
				"vscode",
				"browser-extension"
			].includes(String(entry.audience))) throw Error("account_response_invalid");
			seen.add(challenge.id);
			return {
				...challenge,
				clientName: entry.clientName,
				audience: entry.audience
			};
		}) };
	}
	function readAccountShareApproval(value) {
		if (accountRecord(value).approved !== true) throw Error("account_response_invalid");
		return { approved: true };
	}
	function readAccountControlRequest(value) {
		const row = accountRecord(value);
		if (!exactKeys(row, ["operation", "payload"]) || typeof row.operation !== "string" || !accountControlOperations.has(row.operation)) throw Error("account_request_invalid");
		const operation = row.operation, payload = accountRecord(row.payload);
		let clean;
		if ([
			"team.roster",
			"billing.profile",
			"billing.balances",
			"billing.invoices",
			"billing.portal",
			"billing.client-config",
			"subscription.offer",
			"subscription.status"
		].includes(operation)) {
			if (Object.keys(payload).length) throw Error("account_request_invalid");
			clean = {};
		} else if (operation === "subscription.checkout" || operation === "subscription.portal") {
			if (!exactKeys(payload, operation === "subscription.checkout" ? ["accountRef", "requestId"] : ["accountRef"]) || typeof payload.accountRef !== "string" || !/^account_[a-f0-9]{64}$/.test(payload.accountRef) || operation === "subscription.checkout" && (typeof payload.requestId !== "string" || !ACCOUNT_ID.test(payload.requestId))) throw Error("account_request_invalid");
			clean = {
				accountRef: payload.accountRef,
				...operation === "subscription.checkout" ? { requestId: payload.requestId } : {}
			};
		} else if (operation === "team.invite") {
			if (!exactKeys(payload, [
				"email",
				"role",
				"requestId"
			]) || !["member", "admin"].includes(String(payload.role)) || typeof payload.requestId !== "string" || !ACCOUNT_ID.test(payload.requestId)) throw Error("account_request_invalid");
			clean = {
				email: accountEmail(payload.email),
				role: payload.role,
				requestId: payload.requestId
			};
		} else if (operation === "team.accept") {
			if (!exactKeys(payload, ["email", "inviteToken"]) || typeof payload.inviteToken !== "string" || !/^utk_team_invite_[A-Za-z0-9_-]{43}$/.test(payload.inviteToken)) throw Error("account_request_invalid");
			clean = {
				email: accountEmail(payload.email),
				inviteToken: payload.inviteToken
			};
		} else if (operation === "team.role") {
			if (!exactKeys(payload, [
				"memberId",
				"expectedRevision",
				"role"
			]) || !["member", "admin"].includes(String(payload.role))) throw Error("account_request_invalid");
			clean = {
				memberId: accountResourceId(payload.memberId),
				expectedRevision: accountExpectedRevision(payload.expectedRevision),
				role: payload.role
			};
		} else if (operation === "team.revoke") {
			if (!exactKeys(payload, ["seatId", "expectedRevision"])) throw Error("account_request_invalid");
			clean = {
				seatId: accountResourceId(payload.seatId),
				expectedRevision: accountExpectedRevision(payload.expectedRevision)
			};
		} else throw Error("account_request_invalid");
		return {
			operation,
			payload: clean
		};
	}
	function readAccountPublicUsage(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_usage_invalid");
		const row = value;
		if (![
			"observed",
			"not_configured",
			"link_required",
			"unavailable",
			"reauthentication_required"
		].includes(String(row.state)) || typeof row.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.verifiedAt) || !Number.isFinite(Date.parse(row.verifiedAt))) throw Error("account_usage_invalid");
		if (row.state === "observed") {
			if (row.currency !== "USD" || row.unit !== "micro_usd" || ![
				row.availableMicros,
				row.reservedMicros,
				row.spentMicros
			].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xe8d4a51000)) throw Error("account_usage_invalid");
			return {
				state: "observed",
				verifiedAt: row.verifiedAt,
				currency: "USD",
				unit: "micro_usd",
				availableMicros: row.availableMicros,
				reservedMicros: row.reservedMicros,
				spentMicros: row.spentMicros
			};
		}
		if ([
			"availableMicros",
			"reservedMicros",
			"spentMicros",
			"currency",
			"unit"
		].some((key) => row[key] !== void 0)) throw Error("account_usage_invalid");
		return {
			state: row.state,
			verifiedAt: row.verifiedAt
		};
	}
	function publicAccountProfile(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
		const row = value, result = {};
		if (typeof row.displayName === "string" && row.displayName.length > 0 && row.displayName.length <= 120 && !/[\u0000-\u001f\u007f]/.test(row.displayName)) result.displayName = row.displayName;
		if (typeof row.email === "string" && row.email.length <= 254 && !/[\u0000-\u001f\u007f]/.test(row.email) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.email)) result.email = row.email;
		if (typeof row.plan === "string" && [
			"free",
			"individual",
			"team",
			"enterprise"
		].includes(row.plan)) result.plan = row.plan;
		return Object.keys(result).length ? result : void 0;
	}
	function readAccountPublicSession(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_response_invalid");
		const row = value;
		if (typeof row.configured !== "boolean" || typeof row.authenticated !== "boolean" || typeof row.loginAvailable !== "boolean" || ![
			"signed_out",
			"connecting",
			"connected",
			"unavailable"
		].includes(String(row.state)) || row.authenticated && (!row.configured || row.state !== "connected") || !row.authenticated && (row.profile !== void 0 || row.state === "connected")) throw Error("account_response_invalid");
		const profile = publicAccountProfile(row.profile);
		if (row.profile !== void 0 && !profile) throw Error("account_response_invalid");
		if (row.requiresSignIn !== void 0 && (typeof row.requiresSignIn !== "boolean" || row.authenticated && row.requiresSignIn)) throw Error("account_response_invalid");
		return {
			configured: row.configured,
			authenticated: row.authenticated,
			loginAvailable: row.loginAvailable,
			state: row.state,
			...profile ? { profile } : {},
			...row.requiresSignIn !== void 0 ? { requiresSignIn: row.requiresSignIn } : {}
		};
	}
	var ACCOUNT_REF, ACCOUNT_MAX_CLIENT_RESPONSE_BYTES, ACCOUNT_MAX_RESPONSE_BYTES, ACCOUNT_ID, accountSubscriptionOperations, accountControlOperations, exactKeys, accountResourceId, accountEmail, accountExpectedRevision;
	var init_account_login_protocol = __esmMin((() => {
		ACCOUNT_REF = /^acc_[a-f0-9]{64}$/;
		ACCOUNT_MAX_CLIENT_RESPONSE_BYTES = 262144;
		ACCOUNT_MAX_RESPONSE_BYTES = 16384;
		ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		accountSubscriptionOperations = /* @__PURE__ */ new Set([
			"subscription.offer",
			"subscription.status",
			"subscription.checkout",
			"subscription.portal"
		]);
		accountControlOperations = /* @__PURE__ */ new Set([
			"team.roster",
			"team.invite",
			"team.accept",
			"team.role",
			"team.revoke",
			"billing.profile",
			"billing.balances",
			"billing.invoices",
			"billing.portal",
			"billing.client-config",
			...accountSubscriptionOperations
		]);
		exactKeys = (row, keys) => Object.keys(row).sort().join(",") === keys.slice().sort().join(",");
		accountResourceId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value) ? value : (() => {
			throw Error("account_request_invalid");
		})();
		accountEmail = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? value.toLowerCase() : (() => {
			throw Error("account_request_invalid");
		})();
		accountExpectedRevision = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : (() => {
			throw Error("account_request_invalid");
		})();
	}));
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/design-bridge/account-client.ts
	var account_client_exports = /* @__PURE__ */ __exportAll({
		accountBindingRevision: () => accountBindingRevision,
		adoptUptokeyAccount: () => adoptUptokeyAccount,
		approveUptokeyAccountAccess: () => approveUptokeyAccountAccess,
		bootAccountState: () => bootAccountState,
		consumeUptokeyAccountAccess: () => consumeUptokeyAccountAccess,
		desktopAccount: () => desktopAccount,
		endUptokeyAccount: () => endUptokeyAccount,
		linkedAccountTransport: () => linkedAccountTransport,
		localAccountClient: () => localAccountClient,
		publicAccountSnapshot: () => publicAccountSnapshot,
		publishAccountState: () => publishAccountState,
		readAvailableUptokeyAccounts: () => readAvailableUptokeyAccounts,
		readUptokeyAccount: () => readUptokeyAccount,
		readUptokeyAccountRequests: () => readUptokeyAccountRequests,
		readUptokeyUsage: () => readUptokeyUsage,
		requestAccountMenuLogin: () => requestAccountMenuLogin,
		requestNativeAccountControl: () => requestNativeAccountControl,
		requestUptokeyAccountAccess: () => requestUptokeyAccountAccess,
		startUptokeyLogin: () => startUptokeyLogin,
		subscribeAccountBinding: () => subscribeAccountBinding,
		takeAccountMenuLogin: () => takeAccountMenuLogin,
		unlinkUptokeyAccount: () => unlinkUptokeyAccount,
		uptokeyLoginUrl: () => uptokeyLoginUrl
	});
	function desktopAccount() {
		return typeof window !== "undefined" && Boolean(window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke);
	}
	function localAccountClient() {
		return Boolean(defaultTokenGetter) || desktopAccount() || [
			"localhost",
			"127.0.0.1",
			"[::1]"
		].includes(window.location.hostname);
	}
	/** Official same-origin login; returning keeps the current surface and locale. */
	function uptokeyLoginUrl() {
		const path = window.location.pathname + window.location.search + window.location.hash;
		return "/auth/login?returnTo=" + encodeURIComponent(path.startsWith("/") && !path.startsWith("//") ? path : "/design/index.html#work");
	}
	function linkedAccountTransport() {
		return desktopAccount() || confirmedAccountTransport === "linked";
	}
	function observeAccountTransport(next) {
		const before = linkedAccountTransport();
		confirmedAccountTransport = next;
		if (before !== linkedAccountTransport()) bindingChanged();
	}
	function accountBindingRevision() {
		return bindingRevision;
	}
	function subscribeAccountBinding(listener) {
		bindingListeners.add(listener);
		return () => {
			bindingListeners.delete(listener);
		};
	}
	function bindingChanged() {
		bindingRevision++;
		for (const listener of bindingListeners) listener();
	}
	function observeAccountBinding(accountRef, mutation = false) {
		const changed = observedAccountRef !== accountRef && (observedAccountRef !== void 0 || mutation);
		const transportChanged = accountRef !== null && !linkedAccountTransport();
		if (accountRef !== null) confirmedAccountTransport = "linked";
		observedAccountRef = accountRef;
		confirmedAuthenticated = accountRef !== null;
		if (changed || transportChanged) bindingChanged();
	}
	function cancelMenuLogin() {
		if (!menuLogin) return;
		window.clearTimeout(menuLogin.timer);
		menuLogin.popup?.close();
		menuLogin = void 0;
	}
	function requestAccountMenuLogin(popup) {
		cancelMenuLogin();
		if (workspaceEnded) {
			popup?.close();
			return;
		}
		const request = {
			popup,
			generation: accountGeneration,
			timer: 0
		};
		request.timer = window.setTimeout(() => {
			if (menuLogin === request) cancelMenuLogin();
		}, 3e4);
		menuLogin = request;
		window.dispatchEvent(new Event("uptokey:account-login-request"));
	}
	function takeAccountMenuLogin() {
		const request = menuLogin;
		if (!request) return null;
		menuLogin = void 0;
		window.clearTimeout(request.timer);
		if (workspaceEnded || request.generation !== accountGeneration) {
			request.popup?.close();
			return null;
		}
		return request;
	}
	function clearPublicAccount() {
		accountGeneration++;
		cancelMenuLogin();
		publishAccountState({
			configured: false,
			authenticated: false,
			loginAvailable: false,
			state: "signed_out",
			source: desktopAccount() ? "desktop" : "web"
		});
	}
	function publicAccountSnapshot() {
		return cached;
	}
	function publishAccountState(state) {
		const next = {
			...readAccountPublicSession(state),
			source: state.source
		};
		if (next.state === "connected" || next.state === "signed_out") {
			const changed = confirmedAuthenticated !== void 0 && confirmedAuthenticated !== next.authenticated;
			confirmedAuthenticated = next.authenticated;
			if (!next.authenticated) observedAccountRef = null;
			else if (changed) observedAccountRef = void 0;
			if (changed) bindingChanged();
		}
		const changed = JSON.stringify(cached) !== JSON.stringify(next);
		cached = next;
		if (changed) window.dispatchEvent(new CustomEvent("uptokey:account-state", { detail: cached }));
	}
	function bootAccountState(getToken) {
		if (boot) return boot;
		defaultTokenGetter = getToken;
		let active, sequence = 0, observedRevision = accountReadRevision, stopRefresh;
		const read = async () => {
			const generation = accountGeneration, revision = accountReadRevision, request = ++sequence;
			observedRevision = revision;
			active?.abort();
			const controller = new AbortController();
			active = controller;
			let state;
			try {
				state = await readUptokeyAccount(defaultTokenGetter, controller.signal);
			} catch {
				state = {
					configured: false,
					authenticated: false,
					loginAvailable: false,
					state: "unavailable",
					source: desktopAccount() ? "desktop" : "web"
				};
			}
			if (!controller.signal.aborted && request === sequence && generation === accountGeneration && revision === accountReadRevision && !workspaceEnded && JSON.stringify(cached) !== JSON.stringify(state)) publishAccountState(state);
			if (active === controller) active = void 0;
			return state;
		};
		const refresh = () => {
			if (workspaceEnded) return;
			if (observedRevision !== accountReadRevision) {
				observedRevision = accountReadRevision;
				return;
			}
			read();
		};
		const subscribe = () => {
			stopRefresh ??= subscribeInteractionRefresh(["account"], refresh);
		};
		window.addEventListener("uptokey:workspace-session", (event) => {
			if (!defaultTokenGetter && !desktopAccount()) return;
			const state = event.detail?.state;
			if (state === "ended") {
				accountGeneration++;
				workspaceEnded = true;
				sequence++;
				active?.abort();
				active = void 0;
				stopRefresh?.();
				stopRefresh = void 0;
				cancelMenuLogin();
				brokerActive = false;
				publishAccountState({
					configured: false,
					authenticated: false,
					loginAvailable: false,
					state: "signed_out",
					source: desktopAccount() ? "desktop" : "web"
				});
			} else if (state === "rotated") {
				accountGeneration++;
				workspaceEnded = false;
				subscribe();
				read();
			}
		});
		subscribe();
		return boot = read();
	}
	async function localAccount(path, getToken, signal, input = {}) {
		if (!window.UptokeyHarnessAccount?.request) throw Error("account_client_unavailable");
		const generation = accountGeneration, revision = accountReadRevision, isRead = [
			"status",
			"usage",
			"available",
			"requests"
		].includes(path);
		const admit = () => {
			signal?.throwIfAborted();
			if (workspaceEnded || generation !== accountGeneration) throw new DOMException("account_workspace_session_ended", "AbortError");
			if (isRead && revision !== accountReadRevision) throw new DOMException("account_request_superseded", "AbortError");
		};
		admit();
		const answer = await window.UptokeyHarnessAccount.request(path, input);
		admit();
		const response = new Response(JSON.stringify(answer.body), {
			status: answer.status,
			headers: { "content-type": "application/json" }
		});
		const parsed = await readBoundedJson(response, [
			"available",
			"requests",
			"control"
		].includes(path) ? ACCOUNT_MAX_CLIENT_RESPONSE_BYTES : ACCOUNT_MAX_RESPONSE_BYTES);
		admit();
		if (!parsed.ok) throw Error("account_response_invalid");
		const body = parsed.value;
		if (!response.ok) {
			const error = typeof body.error === "object" && body.error !== null ? body.error.type : body.error;
			const code = typeof error === "string" && /^account_[a-z_]{1,80}$/.test(error) ? error : "account_unavailable";
			if (response.status === 401 || response.status === 403 && !code.startsWith("account_share_")) clearPublicAccount();
			throw Error(code);
		}
		return body;
	}
	async function readUptokeyAccount(getToken, signal) {
		const source = desktopAccount() ? "desktop" : "web";
		try {
			let response;
			brokerActive = Boolean(getToken) || desktopAccount();
			if (brokerActive) {
				response = await localAccount("status", getToken, signal);
				const session = readAccountPublicSession(response);
				if (session.configured) observeAccountTransport("linked");
				return {
					...session,
					source
				};
			}
			const parsed = await readBoundedJson(await accountFetch("/api/account/session", { signal }), 16384);
			signal?.throwIfAborted();
			if (!parsed.ok) throw Error("account_response_invalid");
			response = parsed.value;
			const session = readAccountPublicSession(response);
			observeAccountTransport("web");
			return {
				...session,
				source
			};
		} catch (error) {
			if (error instanceof AccountServiceError && ["unconfigured", "signed_out"].includes(error.code) || error instanceof Error && error.message === "account_service_not_configured") return {
				configured: false,
				authenticated: false,
				loginAvailable: false,
				state: "signed_out",
				source
			};
			throw error;
		}
	}
	async function readAvailableUptokeyAccounts(getToken = defaultTokenGetter, signal) {
		const value = readAccountAvailable(await localAccount("available", getToken, signal));
		observeAccountBinding(value.currentAccountRef);
		return value;
	}
	async function adoptUptokeyAccount(accountRef, expectedRevision, getToken = defaultTokenGetter, signal) {
		const result = readAccountAdoption(await localAccount("adopt", getToken, signal, {
			accountRef,
			expectedRevision
		}));
		accountReadRevision++;
		brokerActive = true;
		observeAccountBinding(accountRef, true);
		publishAccountState({
			...result.session,
			source: desktopAccount() ? "desktop" : "web"
		});
		publishInteractionEffect("account");
		return result;
	}
	async function unlinkUptokeyAccount(expectedRevision, getToken = defaultTokenGetter, signal) {
		const result = readAccountAdoption(await localAccount("unlink", getToken, signal, { expectedRevision }));
		if (result.session.authenticated || result.session.state !== "signed_out") throw Error("account_unlink_unconfirmed");
		accountReadRevision++;
		cancelMenuLogin();
		observeAccountBinding(null, true);
		publishAccountState({
			...result.session,
			source: desktopAccount() ? "desktop" : "web"
		});
		publishInteractionEffect("account");
		return result;
	}
	async function requestUptokeyAccountAccess(getToken = defaultTokenGetter, signal) {
		return readAccountShareChallenge(await localAccount("request", getToken, signal));
	}
	async function readUptokeyAccountRequests(getToken = defaultTokenGetter, signal) {
		return readAccountShareRequests(await localAccount("requests", getToken, signal));
	}
	async function approveUptokeyAccountAccess(id, userCode, accountRef, getToken = defaultTokenGetter, signal) {
		return readAccountShareApproval(await localAccount("approve", getToken, signal, {
			id,
			userCode,
			accountRef
		}));
	}
	async function consumeUptokeyAccountAccess(id, getToken = defaultTokenGetter, signal) {
		return readAccountShareApproval(await localAccount("consume", getToken, signal, { id }));
	}
	async function readUptokeyUsage(getToken = defaultTokenGetter, signal) {
		const verifiedAt = (/* @__PURE__ */ new Date()).toISOString();
		try {
			if (brokerActive || desktopAccount()) return readAccountPublicUsage(await localAccount("usage", getToken, signal));
			const parsed = await readBoundedJson(await accountFetch("/api/account/hosted/usage", { signal }), 16384);
			if (!parsed.ok) throw Error("account_usage_invalid");
			return readAccountPublicUsage({
				state: "observed",
				verifiedAt,
				...parsed.value
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			const code = error instanceof AccountServiceError ? error.code : error instanceof Error ? error.message : "";
			return {
				state: code === "account_link_required" ? "link_required" : ["unconfigured", "account_service_not_configured"].includes(code) ? "not_configured" : ["signed_out", "account_reauthentication_required"].includes(code) ? "reauthentication_required" : "unavailable",
				verifiedAt
			};
		}
	}
	async function requestNativeAccountControl(input, getToken = defaultTokenGetter, signal) {
		const answer = await localAccount("control", getToken, signal, readAccountControlRequest(input));
		if (Object.keys(answer).sort().join(",") !== "body,status" || typeof answer.status !== "number" || !Number.isSafeInteger(answer.status) || answer.status < 100 || answer.status > 599) throw Error("account_response_invalid");
		return {
			status: answer.status,
			body: answer.body
		};
	}
	async function startUptokeyLogin(locale, getToken, signal, browserTab, onPending) {
		const generation = accountGeneration, revision = accountReadRevision, admit = () => {
			signal?.throwIfAborted();
			if (workspaceEnded || generation !== accountGeneration || revision !== accountReadRevision) throw new DOMException("account_request_superseded", "AbortError");
		};
		admit();
		if (!localAccountClient()) {
			browserTab?.close();
			window.location.assign(uptokeyLoginUrl());
			return {};
		}
		const session = await readUptokeyAccount(getToken, signal);
		admit();
		if (!session.configured || !session.loginAvailable || session.authenticated) {
			browserTab?.close();
			return { session };
		}
		if (!brokerActive) {
			browserTab?.close();
			window.location.assign(uptokeyLoginUrl());
			return {};
		}
		const answer = readAccountLoginResponse(await localAccount("login", getToken, signal));
		admit();
		if ("session" in answer) {
			browserTab?.close();
			return { session: {
				...readAccountPublicSession(answer.session),
				source: desktopAccount() ? "desktop" : "web"
			} };
		}
		const url = new URL(answer.loginUrl);
		url.searchParams.set("lang", locale);
		admit();
		onPending?.({
			userCode: answer.userCode,
			expiresAt: answer.expiresAt,
			loginUrl: url.href
		});
		admit();
		if (desktopAccount()) {
			if (!window.UptokeyDesktop?.openAccountLogin) throw Error("account_browser_unavailable");
			try {
				await window.UptokeyDesktop.openAccountLogin(url.href);
			} catch (error) {
				admit();
				throw error;
			}
			admit();
		} else if (browserTab) {
			admit();
			browserTab.opener = null;
			browserTab.location.replace(url.href);
		}
		return {
			userCode: answer.userCode,
			expiresAt: answer.expiresAt,
			loginUrl: url.href
		};
	}
	async function endUptokeyAccount(getToken = defaultTokenGetter, signal) {
		cancelMenuLogin();
		if (brokerActive || desktopAccount()) {
			const session = readAccountPublicSession(await localAccount("logout", getToken, signal));
			if (session.authenticated || session.state !== "signed_out") throw Error("account_logout_unconfirmed");
			accountReadRevision++;
			cancelMenuLogin();
			const state = {
				...session,
				source: desktopAccount() ? "desktop" : "web"
			};
			publishAccountState(state);
			publishInteractionEffect("account");
			return state;
		}
		window.dispatchEvent(new Event("uptokey:session-ended"));
		window.location.assign("/auth/logout?returnTo=" + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash));
	}
	var cached, brokerActive, confirmedAccountTransport, workspaceEnded, accountGeneration, accountReadRevision, bindingRevision, observedAccountRef, confirmedAuthenticated, bindingListeners, menuLogin, boot, defaultTokenGetter;
	var init_account_client = __esmMin((() => {
		init_billing_account();
		init_proxy();
		init_limits();
		init_account_native();
		init_interaction_effects();
		init_account_login_protocol();
		cached = null;
		brokerActive = false;
		confirmedAccountTransport = "web";
		workspaceEnded = false;
		accountGeneration = 0;
		accountReadRevision = 0;
		bindingRevision = 0;
		bindingListeners = /* @__PURE__ */ new Set();
	}));
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/design-bridge/account-rail.ts
	init_account_client();
	const invitationUrl = "https://uptokey.com/";
	function mountAccountRail(doc = document, events = window) {
		let state = publicAccountSnapshot(), button = null, disposed = false, busy = false, pendingFocus = null, positionFrame = null;
		const request = new AbortController(), menu = doc.createElement("div"), items = doc.createElement("div"), identity = doc.createElement("div"), feedback = doc.createElement("div");
		const locale = () => accountLocales.find((value) => value === doc.documentElement.lang) || "en";
		const text = (key) => accountLabel(locale(), key);
		const emit = (action) => events.dispatchEvent(new CustomEvent("uptokey:user-action", { detail: { action } }));
		menu.id = "uptokey-account-menu";
		menu.className = "account-menu";
		menu.hidden = true;
		menu.tabIndex = -1;
		menu.setAttribute("role", "menu");
		identity.className = "account-menu-identity";
		identity.setAttribute("role", "presentation");
		items.setAttribute("role", "presentation");
		feedback.className = "account-menu-feedback";
		feedback.setAttribute("role", "status");
		feedback.setAttribute("aria-live", "polite");
		menu.append(identity, items, feedback);
		const controls = () => Array.from(items.querySelectorAll("button:not(:disabled)"));
		const close = (restore = false) => {
			if (positionFrame !== null) {
				events.cancelAnimationFrame(positionFrame);
				positionFrame = null;
			}
			menu.hidden = true;
			button?.setAttribute("aria-expanded", "false");
			if (restore) button?.focus({ preventScroll: true });
		};
		const position = () => {
			if (!button || menu.hidden) return;
			const box = button.getBoundingClientRect(), width = Math.max(0, Math.min(280, events.innerWidth - 24)), above = box.top - 18, below = events.innerHeight - box.bottom - 18;
			const openAbove = above >= below;
			menu.style.width = width + "px";
			menu.style.maxHeight = Math.max(0, Math.min(events.innerHeight - 24, Math.max(80, openAbove ? above : below))) + "px";
			menu.style.bottom = "auto";
			const height = menu.getBoundingClientRect().height, top = openAbove ? box.top - height - 6 : box.bottom + 6;
			menu.style.top = Math.max(12, Math.min(top, events.innerHeight - height - 12)) + "px";
			menu.style.left = Math.max(12, Math.min(locale() === "ar" ? box.right - width : box.left, events.innerWidth - width - 12)) + "px";
			const focused = doc.activeElement;
			if (focused instanceof HTMLElement && focused !== menu && menu.contains(focused)) {
				const itemBox = focused.getBoundingClientRect(), menuBox = menu.getBoundingClientRect();
				if (itemBox.top < menuBox.top + 6) menu.scrollTop -= menuBox.top + 6 - itemBox.top;
				else if (itemBox.bottom > menuBox.bottom - 6) menu.scrollTop += itemBox.bottom - menuBox.bottom + 6;
			}
		};
		const reposition = () => {
			if (disposed || menu.hidden || positionFrame !== null) return;
			positionFrame = events.requestAnimationFrame(() => {
				positionFrame = null;
				if (!disposed) position();
			});
		};
		const disclosure = (event) => {
			if (event.target instanceof HTMLDetailsElement) reposition();
		};
		const fail = (value) => {
			feedback.removeAttribute("data-account-feedback-text");
			feedback.replaceChildren();
			const message = doc.createElement("p");
			message.dataset.accountFeedbackText = "unavailable";
			message.textContent = text("unavailable");
			feedback.append(message);
			const code = value instanceof Error && /^[a-z][a-z0-9_]{0,99}$/.test(value.message) ? value.message : "account_unavailable";
			const details = doc.createElement("details"), summary = doc.createElement("summary"), technical = doc.createElement("code");
			summary.dataset.accountFeedbackText = "technical";
			summary.textContent = text("technical");
			technical.textContent = code;
			technical.setAttribute("translate", "no");
			details.append(summary, technical);
			feedback.append(details);
			reposition();
		};
		const beginBusy = (action) => {
			pendingFocus = doc.activeElement?.dataset.accountAction === action ? action : null;
			busy = true;
			paintMenu();
			if (pendingFocus && !menu.hidden) menu.focus({ preventScroll: true });
		};
		const finishBusy = () => {
			const restore = !menu.hidden && doc.activeElement === menu ? pendingFocus : null;
			busy = false;
			pendingFocus = null;
			if (disposed) return;
			paintMenu();
			if (restore) items.querySelector(`[data-account-action="${restore}"]`)?.focus({ preventScroll: true });
		};
		const inviteNotice = (key) => {
			feedback.dataset.accountFeedbackText = key;
			feedback.textContent = text(key);
			reposition();
		};
		const inviteFallback = () => {
			feedback.removeAttribute("data-account-feedback-text");
			feedback.replaceChildren();
			const note = doc.createElement("p"), link = doc.createElement("input");
			note.dataset.accountFeedbackText = "inviteManual";
			note.textContent = text("inviteManual");
			link.type = "text";
			link.readOnly = true;
			link.value = invitationUrl;
			link.className = "account-menu-item";
			link.dataset.accountInviteLink = "";
			link.setAttribute("aria-label", text("inviteLink"));
			link.setAttribute("translate", "no");
			link.dir = "ltr";
			link.addEventListener("focus", () => link.select());
			feedback.append(note, link);
			reposition();
			if (!menu.hidden && doc.activeElement === menu) {
				link.focus({ preventScroll: true });
				link.select();
			}
		};
		const invite = async () => {
			try {
				if (!desktopAccount() && typeof events.navigator.share === "function") try {
					await events.navigator.share({
						title: "Uptokey",
						url: invitationUrl
					});
					if (!disposed) inviteNotice("inviteShared");
					return;
				} catch (value) {
					if (value instanceof DOMException && value.name === "AbortError") return;
				}
				if (disposed) return;
				if (!events.navigator.clipboard?.writeText) throw Error("clipboard_unavailable");
				await events.navigator.clipboard.writeText(invitationUrl);
				if (!disposed) inviteNotice("inviteCopied");
			} catch {
				if (!disposed) inviteFallback();
			} finally {
				finishBusy();
			}
		};
		const activate = (action) => {
			if (busy || disposed) return;
			if (action === "invite") {
				feedback.removeAttribute("data-account-feedback-text");
				feedback.replaceChildren();
				beginBusy(action);
				invite();
				return;
			}
			if (action === "signIn") {
				if (!localAccountClient()) {
					close();
					events.location.assign(uptokeyLoginUrl());
					return;
				}
				const popup = !desktopAccount() && localAccountClient() ? events.open("about:blank", "_blank") : null;
				if (popup) popup.opener = null;
				close();
				requestAccountMenuLogin(popup);
				return;
			}
			if (action === "signOut") {
				feedback.dataset.accountFeedbackText = "loading";
				feedback.textContent = text("loading");
				beginBusy(action);
				endUptokeyAccount(void 0, request.signal).then((next) => {
					if (disposed || request.signal.aborted) return;
					if (next) publishAccountState(next);
					if (!menu.hidden) close(true);
				}).catch((value) => {
					if (!disposed && !request.signal.aborted) fail(value);
				}).finally(finishBusy);
				return;
			}
			if (action === "help") {
				const url = "https://docs.uptokey.com/" + locale().toLowerCase() + "/";
				if (desktopAccount()) {
					if (!events.UptokeyDesktop?.openModelPage) {
						fail(Error("account_help_unavailable"));
						return;
					}
					beginBusy(action);
					events.UptokeyDesktop.openModelPage(url).then(() => {
						if (!disposed && !menu.hidden) close(true);
					}).catch((value) => {
						if (!disposed) fail(value);
					}).finally(finishBusy);
				} else {
					events.open(url, "_blank", "noopener,noreferrer");
					close(true);
				}
				return;
			}
			close();
			emit(action);
		};
		const paintMenu = () => {
			const focused = doc.activeElement instanceof HTMLElement && items.contains(doc.activeElement) ? doc.activeElement.dataset.accountAction : null;
			menu.setAttribute("aria-label", text("menu"));
			menu.dir = locale() === "ar" ? "rtl" : "ltr";
			identity.replaceChildren();
			if (state?.authenticated && state.profile) {
				const name = doc.createElement("strong");
				name.textContent = state.profile.displayName || state.profile.email || text("title");
				name.setAttribute("translate", "no");
				identity.append(name);
				if (state.profile.email && state.profile.displayName) {
					const email = doc.createElement("span");
					email.textContent = state.profile.email;
					email.setAttribute("translate", "no");
					identity.append(email);
				}
				if (state.profile.plan === "free") {
					const badge = doc.createElement("span");
					badge.className = "account-free";
					badge.dataset.accountMenuPlan = "";
					badge.textContent = text("freePlan");
					identity.append(badge);
				}
			}
			identity.hidden = !identity.childElementCount;
			items.replaceChildren();
			for (const action of [
				"account",
				"usage",
				"settings",
				"invite",
				"help",
				state?.authenticated ? "signOut" : "signIn"
			]) {
				if (action === "signIn" || action === "signOut") {
					const separator = doc.createElement("div");
					separator.className = "account-menu-separator";
					separator.setAttribute("role", "separator");
					items.append(separator);
				}
				const row = doc.createElement("button");
				row.type = "button";
				row.className = "account-menu-item";
				row.dataset.accountAction = action;
				row.dataset.actionTone = action === "signOut" ? "exit" : "quiet";
				row.setAttribute("role", "menuitem");
				row.tabIndex = -1;
				row.disabled = busy;
				row.textContent = text(action === "signIn" || action === "signOut" ? action : "menu" + action[0].toUpperCase() + action.slice(1));
				row.onclick = () => activate(action);
				items.append(row);
			}
			if (focused && !menu.hidden) (items.querySelector(`[data-account-action="${focused}"]`) || controls().at(-1))?.focus({ preventScroll: true });
			reposition();
		};
		const paint = () => {
			if (!button || disposed) return;
			const name = state?.authenticated ? state.profile?.displayName || state.profile?.email || text("title") : text("avatarSignIn");
			const symbol = doc.createElement("span");
			symbol.className = "glyph account-avatar";
			symbol.setAttribute("aria-hidden", "true");
			symbol.textContent = state?.authenticated ? Array.from(name.trim())[0]?.toLocaleUpperCase() || "U" : "U";
			const label = doc.createElement("span");
			label.className = "label account-identity";
			label.textContent = name;
			if (state?.authenticated) label.setAttribute("translate", "no");
			button.replaceChildren(symbol, label);
			if (state?.authenticated) button.setAttribute("aria-haspopup", "menu");
			else button.removeAttribute("aria-haspopup");
			button.dataset.accountReady = "true";
			button.setAttribute("aria-label", name);
			button.title = name;
			if (state?.authenticated && state.profile?.plan === "free") {
				const badge = doc.createElement("span");
				badge.className = "account-free";
				badge.textContent = text("freePlan");
				button.append(badge);
			}
			paintMenu();
			for (const node of [feedback, ...Array.from(feedback.querySelectorAll("[data-account-feedback-text]"))]) if (node.dataset.accountFeedbackText) node.textContent = text(node.dataset.accountFeedbackText);
			feedback.querySelector("[data-account-invite-link]")?.setAttribute("aria-label", text("inviteLink"));
			reposition();
		};
		const toggle = () => {
			if (!button || disposed) return;
			if (!menu.hidden) {
				close(true);
				return;
			}
			feedback.removeAttribute("data-account-feedback-text");
			feedback.replaceChildren();
			paintMenu();
			menu.hidden = false;
			button.setAttribute("aria-expanded", "true");
			position();
			controls()[0]?.focus({ preventScroll: true });
		};
		const directSignIn = () => {
			if (!state?.authenticated) {
				activate("signIn");
				return;
			}
			toggle();
		};
		const buttonKey = (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (menu.hidden) toggle();
				if (event.key === "ArrowUp") controls().at(-1)?.focus({ preventScroll: true });
			}
		};
		const menuKey = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close(true);
				return;
			}
			if (event.key === "Tab") {
				const extra = feedback.querySelector("input,summary");
				if (extra && !feedback.contains(doc.activeElement)) {
					event.preventDefault();
					extra.focus({ preventScroll: true });
					return;
				}
				if (extra && event.shiftKey) {
					event.preventDefault();
					controls().at(-1)?.focus({ preventScroll: true });
					return;
				}
				close(true);
				return;
			}
			if (event.target instanceof HTMLInputElement) return;
			const rows = controls();
			if (!rows.length) return;
			const index = rows.indexOf(doc.activeElement);
			const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : event.key === "ArrowDown" ? (index + 1) % rows.length : event.key === "ArrowUp" ? (index - 1 + rows.length) % rows.length : null;
			if (next !== null) {
				event.preventDefault();
				rows[next]?.focus({ preventScroll: true });
			}
		};
		const place = () => {
			const footer = doc.querySelector(".rail-footer"), candidate = doc.querySelector(".avatar");
			if (!footer || !candidate) return;
			button = candidate;
			button.classList.add("item", "account-rail");
			button.removeAttribute("data-ui-aria");
			button.removeAttribute("data-ui-title");
			button.setAttribute("aria-haspopup", "menu");
			button.setAttribute("aria-controls", menu.id);
			button.setAttribute("aria-expanded", "false");
			button.addEventListener("click", directSignIn);
			button.addEventListener("keydown", buttonKey);
			if (button.parentElement !== footer) footer.append(button);
			doc.body.append(menu);
			paint();
			observer.disconnect();
		};
		const observer = new MutationObserver(place), update = () => {
			state = publicAccountSnapshot();
			paint();
		};
		const outside = (event) => {
			if (!menu.contains(event.target) && !button?.contains(event.target)) close();
		};
		events.addEventListener("uptokey:account-state", update);
		events.addEventListener("uptokey:locale", paint);
		events.addEventListener("uptokey:account-menu-toggle", toggle);
		events.addEventListener("resize", position);
		doc.addEventListener("pointerdown", outside);
		menu.addEventListener("keydown", menuKey);
		menu.addEventListener("focusin", reposition);
		feedback.addEventListener("toggle", disclosure, true);
		observer.observe(doc.documentElement, {
			childList: true,
			subtree: true
		});
		place();
		return () => {
			disposed = true;
			request.abort();
			observer.disconnect();
			close();
			menu.remove();
			button?.removeEventListener("click", directSignIn);
			button?.removeEventListener("keydown", buttonKey);
			events.removeEventListener("uptokey:account-state", update);
			events.removeEventListener("uptokey:locale", paint);
			events.removeEventListener("uptokey:account-menu-toggle", toggle);
			events.removeEventListener("resize", position);
			doc.removeEventListener("pointerdown", outside);
			menu.removeEventListener("keydown", menuKey);
			menu.removeEventListener("focusin", reposition);
			feedback.removeEventListener("toggle", disclosure, true);
		};
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/subscription-i18n.ts
	var import_hooks = (/* @__PURE__ */ __commonJSMin(((exports) => {
		var n;
		var t;
		var r;
		var u;
		var o = require_preact();
		var i = 0;
		var f = [];
		var c = o.options;
		var e = c.__b;
		var a = c.__r;
		var v = c.diffed;
		var s = c.__c;
		var l = c.unmount;
		var p = c.__;
		function x(n, r) {
			c.__h && c.__h(t, n, i || r), i = 0;
			var u = t.__H || (t.__H = {
				__: [],
				__h: []
			});
			return n >= u.__.length && u.__.push({}), u.__[n];
		}
		function m(n) {
			return i = 1, d(b, n);
		}
		function d(r, u, o) {
			var i = x(n++, 2);
			if (i.t = r, !i.__c && (i.__ = [o ? o(u) : b(void 0, u), function(n) {
				var t = i.__N ? i.__N[0] : i.__[0], r = i.t(t, n);
				t !== r && (i.__N = [r, i.__[1]], i.__c.setState({}));
			}], i.__c = t, !t.__f)) {
				var f = function(n, t, r) {
					if (!i.__c.__H) return !0;
					var u = !1, o = i.__c.props !== n;
					if (i.__c.__H.__.some(function(n) {
						if (n.__N) {
							u = !0;
							var t = n.__[0];
							n.__ = n.__N, n.__N = void 0, t !== n.__[0] && (o = !0);
						}
					}), c) {
						var f = c.call(this, n, t, r);
						return u ? f || o : f;
					}
					return !u || o;
				};
				t.__f = !0;
				var c = t.shouldComponentUpdate, e = t.componentWillUpdate;
				t.componentWillUpdate = function(n, t, r) {
					if (this.__e) {
						var u = c;
						c = void 0, f(n, t, r), c = u;
					}
					e && e.call(this, n, t, r);
				}, t.shouldComponentUpdate = f;
			}
			return i.__N || i.__;
		}
		function y(r, u) {
			var o = x(n++, 4);
			!c.__s && P(o.__H, u) && (o.__ = r, o.u = u, t.__h.push(o));
		}
		function h(t, r) {
			var u = x(n++, 7);
			return P(u.__H, r) && (u.__ = t(), u.__H = r, u.__h = t), u.__;
		}
		function _() {
			for (var n; n = f.shift();) {
				var t = n.__H;
				if (n.__P && t) try {
					t.__h.some(F), t.__h.some(T), t.__h = [];
				} catch (r) {
					t.__h = [], c.__e(r, n.__v);
				}
			}
		}
		c.__b = function(n) {
			t = null, e && e(n);
		}, c.__ = function(n, t) {
			n && t.__k && t.__k.__m && (n.__m = t.__k.__m), p && p(n, t);
		}, c.__r = function(u) {
			a && a(u), n = 0;
			var o = (t = u.__c).__H;
			o && (r === t ? (o.__h = [], t.__h = [], o.__.some(function(n) {
				n.__N && (n.__ = n.__N), n.u = n.__N = void 0;
			})) : (o.__h.some(F), o.__h.some(T), o.__h = [], n = 0)), r = t;
		}, c.diffed = function(n) {
			v && v(n);
			var o = n.__c;
			o && o.__H && (o.__H.__h.length && (1 !== f.push(o) && u === c.requestAnimationFrame || ((u = c.requestAnimationFrame) || A)(_)), o.__H.__.some(function(n) {
				n.u && (n.__H = n.u, n.u = void 0);
			})), r = t = null;
		}, c.__c = function(n, t) {
			t.some(function(n) {
				try {
					n.__h.some(F), n.__h = n.__h.filter(function(n) {
						return !n.__ || T(n);
					});
				} catch (r) {
					t.some(function(n) {
						n.__h && (n.__h = []);
					}), t = [], c.__e(r, n.__v);
				}
			}), s && s(n, t);
		}, c.unmount = function(n) {
			l && l(n);
			var t, r = n.__c;
			r && r.__H && (r.__H.__.some(function(n) {
				try {
					F(n);
				} catch (n) {
					t = n;
				}
			}), r.__H = void 0, t && c.__e(t, r.__v));
		};
		var q = "function" == typeof requestAnimationFrame;
		function A(n) {
			var t, r = function() {
				clearTimeout(u), q && cancelAnimationFrame(t), setTimeout(n);
			}, u = setTimeout(r, 35);
			q && (t = requestAnimationFrame(r));
		}
		function F(n) {
			var r = t, u = n.__c;
			"function" == typeof u && (n.__c = void 0, u()), t = r;
		}
		function T(n) {
			var r = t;
			n.__c = n.__(), t = r;
		}
		function P(n, t) {
			return !n || n.length !== t.length || t.some(function(t, r) {
				return t !== n[r];
			});
		}
		function b(n, t) {
			return "function" == typeof t ? t(n) : t;
		}
		exports.useCallback = function(n, t) {
			return i = 8, h(function() {
				return n;
			}, t);
		}, exports.useContext = function(r) {
			var u = t.context[r.__c], o = x(n++, 9);
			return o.c = r, u ? (o.__ ?? (o.__ = !0, u.sub(t)), u.props.value) : r.__;
		}, exports.useDebugValue = function(n, t) {
			c.useDebugValue && c.useDebugValue(t ? t(n) : n);
		}, exports.useEffect = function(r, u) {
			var o = x(n++, 3);
			!c.__s && P(o.__H, u) && (o.__ = r, o.u = u, t.__H.__h.push(o));
		}, exports.useErrorBoundary = function(r) {
			var u = x(n++, 10), o = m();
			return u.__ = r, t.componentDidCatch || (t.componentDidCatch = function(n, t) {
				u.__ && u.__(n, t), o[1](n);
			}), [o[0], function() {
				o[1](void 0);
			}];
		}, exports.useId = function() {
			var r = x(n++, 11);
			if (!r.__) {
				for (var u = t.__v; null !== u && !u.__m && null !== u.__;) u = u.__;
				var o = u.__m || (u.__m = [0, 0]);
				r.__ = "P" + o[0] + "-" + o[1]++;
			}
			return r.__;
		}, exports.useImperativeHandle = function(n, t, r) {
			i = 6, y(function() {
				if ("function" == typeof n) {
					var r = n(t());
					return function() {
						n(null), r && "function" == typeof r && r();
					};
				}
				if (n) return n.current = t(), function() {
					return n.current = null;
				};
			}, null == r ? r : r.concat(n));
		}, exports.useLayoutEffect = y, exports.useMemo = h, exports.useReducer = d, exports.useRef = function(n) {
			return i = 5, h(function() {
				return { current: n };
			}, []);
		}, exports.useState = m;
	})))();
	const checkoutCopy = {
		en: {
			activationPending: "Plus checkout is awaiting activation. You can keep using Free.",
			activationPendingLabel: "Activation pending",
			checkoutPending: "Checkout is still being prepared. Continue with the same request."
		},
		"pt-BR": {
			activationPending: "O pagamento do Plus aguarda ativação. Você pode continuar no plano grátis.",
			activationPendingLabel: "Aguardando ativação",
			checkoutPending: "O pagamento ainda está sendo preparado. Continue com a mesma solicitação."
		},
		es: {
			activationPending: "El pago de Plus está pendiente de activación. Puedes seguir con el plan gratis.",
			activationPendingLabel: "Activación pendiente",
			checkoutPending: "El pago aún se está preparando. Continúa con la misma solicitud."
		},
		fr: {
			activationPending: "Le paiement de Plus attend son activation. Vous pouvez continuer avec l’offre gratuite.",
			activationPendingLabel: "Activation en attente",
			checkoutPending: "Le paiement est en cours de préparation. Continuez avec la même demande."
		},
		de: {
			activationPending: "Die Zahlung für Plus wartet auf Freischaltung. Du kannst den kostenlosen Tarif weiter nutzen.",
			activationPendingLabel: "Freischaltung ausstehend",
			checkoutPending: "Die Zahlung wird noch vorbereitet. Fahre mit derselben Anfrage fort."
		},
		it: {
			activationPending: "Il pagamento di Plus è in attesa di attivazione. Puoi continuare con il piano gratuito.",
			activationPendingLabel: "Attivazione in attesa",
			checkoutPending: "Il pagamento è ancora in preparazione. Continua con la stessa richiesta."
		},
		ja: {
			activationPending: "Plusの決済は有効化待ちです。無料プランは引き続き利用できます。",
			activationPendingLabel: "有効化待ち",
			checkoutPending: "決済を準備しています。同じリクエストで続行できます。"
		},
		ko: {
			activationPending: "Plus 결제 활성화를 기다리고 있습니다. 무료 요금제는 계속 이용할 수 있습니다.",
			activationPendingLabel: "활성화 대기 중",
			checkoutPending: "결제를 준비하고 있습니다. 같은 요청으로 계속 진행하세요."
		},
		"zh-CN": {
			activationPending: "Plus 支付功能正在等待开通。你仍可使用免费方案。",
			activationPendingLabel: "等待开通",
			checkoutPending: "结账仍在准备中。请继续处理同一请求。"
		},
		ar: {
			activationPending: "الدفع لاشتراك Plus بانتظار التفعيل. يمكنك متابعة استخدام الخطة المجانية.",
			activationPendingLabel: "بانتظار التفعيل",
			checkoutPending: "لا تزال صفحة الدفع قيد الإعداد. تابع الطلب نفسه."
		}
	};
	const en$1 = {
		...checkoutCopy.en,
		opening: "Opening secure checkout…",
		title: "Your plan",
		free: "Free",
		plus: "Plus",
		freeCopy: "Local models and BYOK (your own API keys) are always free. Cloud AI has usage limits. No subscription or payment card required. Hardware and provider costs are separate.",
		plusCopy: "More cloud AI with a fixed monthly allowance. Keep the same chats and models. Cancel any time.",
		month: "/ month",
		getPlus: "Get Plus",
		manage: "Manage subscription",
		cancel: "Cancel subscription",
		allowance: "{amount} monthly AI budget",
		remaining: "{amount} remaining",
		renews: "Renews {date}",
		ends: "Available until {date}",
		pending: "Confirming your subscription…",
		retry: "Try again",
		close: "Close",
		unavailable: "Could not load your plan. Try again.",
		actionFailed: "Could not open checkout. Try again.",
		portalFailed: "Could not open subscription settings. Try again.",
		active: "Current plan",
		paymentDue: "Update payment",
		paused: "Paused",
		canceled: "Canceled",
		taxes: "Taxes calculated at checkout.",
		continue: "Continue to checkout",
		browser: "Open your account"
	};
	const subscriptionLocales = [
		"en",
		"pt-BR",
		"es",
		"fr",
		"de",
		"it",
		"ja",
		"ko",
		"zh-CN",
		"ar"
	];
	const copy = {
		en: en$1,
		"pt-BR": {
			opening: "Abrindo pagamento seguro…",
			title: "Seu plano",
			free: "Grátis",
			plus: "Plus",
			freeCopy: "Modelos locais e suas chaves de API continuam sempre grátis. A IA na nuvem tem limites. Sem assinatura ou cartão. Hardware e provedores têm custos próprios.",
			plusCopy: "Mais IA na nuvem com uma franquia mensal definida. Continue com os mesmos chats e modelos. Cancele quando quiser.",
			month: "/ mês",
			getPlus: "Assinar Plus",
			manage: "Gerenciar assinatura",
			cancel: "Cancelar assinatura",
			allowance: "{amount} por mês para IA",
			remaining: "{amount} restantes",
			renews: "Renova em {date}",
			ends: "Disponível até {date}",
			pending: "Confirmando sua assinatura…",
			retry: "Tentar novamente",
			close: "Fechar",
			unavailable: "Não foi possível carregar seu plano. Tente novamente.",
			actionFailed: "Não foi possível abrir o pagamento. Tente novamente.",
			portalFailed: "Não foi possível abrir a gestão da assinatura. Tente novamente.",
			active: "Plano atual",
			paymentDue: "Atualizar pagamento",
			paused: "Pausado",
			canceled: "Cancelado",
			taxes: "Impostos calculados no pagamento.",
			continue: "Continuar para pagamento",
			browser: "Abrir sua conta"
		},
		es: {
			opening: "Abriendo el pago seguro…",
			title: "Tu plan",
			free: "Gratis",
			plus: "Plus",
			freeCopy: "Los modelos locales y tus claves API siguen siendo gratis. La IA en la nube tiene límites. Sin suscripción ni tarjeta. Equipo y proveedores tienen costes propios.",
			plusCopy: "Más IA en la nube con un presupuesto mensual definido. Conserva tus chats y modelos. Cancela cuando quieras.",
			month: "/ mes",
			getPlus: "Obtener Plus",
			manage: "Gestionar suscripción",
			cancel: "Cancelar suscripción",
			allowance: "{amount} al mes para IA",
			remaining: "{amount} disponibles",
			renews: "Se renueva el {date}",
			ends: "Disponible hasta el {date}",
			pending: "Confirmando tu suscripción…",
			retry: "Reintentar",
			close: "Cerrar",
			unavailable: "No se pudo cargar tu plan. Reintenta.",
			actionFailed: "No se pudo abrir el pago. Reintenta.",
			portalFailed: "No se pudo abrir la gestión de la suscripción. Reintenta.",
			active: "Plan actual",
			paymentDue: "Actualizar pago",
			paused: "En pausa",
			canceled: "Cancelada",
			taxes: "Impuestos calculados al pagar.",
			continue: "Continuar al pago",
			browser: "Abrir tu cuenta"
		},
		fr: {
			opening: "Ouverture du paiement sécurisé…",
			title: "Votre offre",
			free: "Gratuit",
			plus: "Plus",
			freeCopy: "Les modèles locaux et vos clés API restent gratuits. L’IA cloud a des limites. Sans abonnement ni carte. Matériel et fournisseurs sont facturés séparément.",
			plusCopy: "Plus d’IA cloud avec un budget mensuel défini. Retrouvez vos conversations et modèles. Résiliez à tout moment.",
			month: "/ mois",
			getPlus: "Choisir Plus",
			manage: "Gérer l’abonnement",
			cancel: "Résilier l’abonnement",
			allowance: "{amount} par mois pour l’IA",
			remaining: "{amount} restants",
			renews: "Renouvellement le {date}",
			ends: "Disponible jusqu’au {date}",
			pending: "Confirmation de votre abonnement…",
			retry: "Réessayer",
			close: "Fermer",
			unavailable: "Impossible de charger votre offre. Réessayez.",
			actionFailed: "Impossible d’ouvrir le paiement. Réessayez.",
			portalFailed: "Impossible d’ouvrir la gestion de l’abonnement. Réessayez.",
			active: "Offre actuelle",
			paymentDue: "Mettre à jour le paiement",
			paused: "En pause",
			canceled: "Résilié",
			taxes: "Taxes calculées au paiement.",
			continue: "Passer au paiement",
			browser: "Ouvrir votre compte"
		},
		de: {
			opening: "Sichere Zahlung wird geöffnet…",
			title: "Dein Tarif",
			free: "Kostenlos",
			plus: "Plus",
			freeCopy: "Lokale Modelle und eigene API-Schlüssel bleiben kostenlos. Cloud-KI hat Nutzungslimits. Kein Abo und keine Karte nötig. Hardware- und Anbieterkosten fallen separat an.",
			plusCopy: "Mehr Cloud-KI mit festem Monatsbudget. Behalte deine Chats und Modelle. Jederzeit kündbar.",
			month: "/ Monat",
			getPlus: "Plus abonnieren",
			manage: "Abo verwalten",
			cancel: "Abo kündigen",
			allowance: "{amount} KI-Budget pro Monat",
			remaining: "{amount} verfügbar",
			renews: "Verlängerung am {date}",
			ends: "Verfügbar bis {date}",
			pending: "Dein Abo wird bestätigt…",
			retry: "Erneut versuchen",
			close: "Schließen",
			unavailable: "Dein Tarif konnte nicht geladen werden. Versuche es erneut.",
			actionFailed: "Die Zahlung konnte nicht geöffnet werden. Versuche es erneut.",
			portalFailed: "Die Aboverwaltung konnte nicht geöffnet werden. Versuche es erneut.",
			active: "Aktueller Tarif",
			paymentDue: "Zahlung aktualisieren",
			paused: "Pausiert",
			canceled: "Gekündigt",
			taxes: "Steuern werden beim Bezahlen berechnet.",
			continue: "Weiter zur Zahlung",
			browser: "Konto öffnen"
		},
		it: {
			opening: "Apertura del pagamento sicuro…",
			title: "Il tuo piano",
			free: "Gratis",
			plus: "Plus",
			freeCopy: "I modelli locali e le tue chiavi API restano gratuiti. L’IA cloud ha limiti di utilizzo. Nessun abbonamento o carta richiesti. Hardware e fornitori hanno costi separati.",
			plusCopy: "Più IA cloud con un budget mensile definito. Mantieni chat e modelli. Disdici quando vuoi.",
			month: "/ mese",
			getPlus: "Attiva Plus",
			manage: "Gestisci abbonamento",
			cancel: "Disdici abbonamento",
			allowance: "{amount} al mese per l’IA",
			remaining: "{amount} disponibili",
			renews: "Si rinnova il {date}",
			ends: "Disponibile fino al {date}",
			pending: "Conferma dell’abbonamento…",
			retry: "Riprova",
			close: "Chiudi",
			unavailable: "Impossibile caricare il piano. Riprova.",
			actionFailed: "Impossibile aprire il pagamento. Riprova.",
			portalFailed: "Impossibile aprire la gestione dell’abbonamento. Riprova.",
			active: "Piano attuale",
			paymentDue: "Aggiorna pagamento",
			paused: "In pausa",
			canceled: "Disdetto",
			taxes: "Imposte calcolate al pagamento.",
			continue: "Procedi al pagamento",
			browser: "Apri il tuo account"
		},
		ja: {
			opening: "安全な決済画面を開いています…",
			title: "ご利用プラン",
			free: "無料",
			plus: "Plus",
			freeCopy: "ローカルモデルと自分のAPIキーは引き続き無料。クラウドAIには利用上限があります。購読やカード登録は不要。機器や提供元の料金は別途かかります。",
			plusCopy: "月ごとの利用枠でクラウドAIをもっと活用。同じチャットとモデルを引き続き利用でき、いつでも解約できます。",
			month: "/ 月",
			getPlus: "Plusに登録",
			manage: "サブスクリプションを管理",
			cancel: "サブスクリプションを解約",
			allowance: "月額{amount}のAI利用枠",
			remaining: "残り{amount}",
			renews: "更新日：{date}",
			ends: "{date}まで利用可能",
			pending: "サブスクリプションを確認中…",
			retry: "再試行",
			close: "閉じる",
			unavailable: "プランを読み込めませんでした。再試行してください。",
			actionFailed: "決済画面を開けませんでした。再試行してください。",
			portalFailed: "サブスクリプションの設定を開けませんでした。再試行してください。",
			active: "現在のプラン",
			paymentDue: "支払方法を更新",
			paused: "一時停止中",
			canceled: "解約済み",
			taxes: "税額は決済時に計算されます。",
			continue: "決済へ進む",
			browser: "アカウントを開く"
		},
		ko: {
			opening: "안전한 결제 창을 여는 중…",
			title: "내 요금제",
			free: "무료",
			plus: "Plus",
			freeCopy: "로컬 모델과 개인 API 키 사용은 계속 무료입니다. 클라우드 AI에는 이용 한도가 있습니다. 구독이나 카드가 필요 없으며 하드웨어 및 제공업체 비용은 별도입니다.",
			plusCopy: "정해진 월간 이용 한도로 클라우드 AI를 더 활용하세요. 기존 대화와 모델을 그대로 이용하며 언제든 해지할 수 있습니다.",
			month: "/ 월",
			getPlus: "Plus 구독",
			manage: "구독 관리",
			cancel: "구독 해지",
			allowance: "월 AI 이용 한도 {amount}",
			remaining: "{amount} 남음",
			renews: "갱신일: {date}",
			ends: "{date}까지 이용 가능",
			pending: "구독 확인 중…",
			retry: "다시 시도",
			close: "닫기",
			unavailable: "요금제를 불러오지 못했습니다. 다시 시도하세요.",
			actionFailed: "결제 창을 열지 못했습니다. 다시 시도하세요.",
			portalFailed: "구독 설정을 열지 못했습니다. 다시 시도하세요.",
			active: "현재 요금제",
			paymentDue: "결제 정보 변경",
			paused: "일시 정지",
			canceled: "해지됨",
			taxes: "세금은 결제 시 계산됩니다.",
			continue: "결제 계속하기",
			browser: "계정 열기"
		},
		"zh-CN": {
			opening: "正在打开安全支付页面…",
			title: "你的方案",
			free: "免费",
			plus: "Plus",
			freeCopy: "本地模型和自有 API 密钥始终免费使用。云端 AI 有使用限额。无需订阅或支付卡，硬件和提供商费用另计。",
			plusCopy: "每月固定额度，畅享更多云端 AI。保留现有对话和模型，随时取消订阅。",
			month: "/ 月",
			getPlus: "订阅 Plus",
			manage: "管理订阅",
			cancel: "取消订阅",
			allowance: "每月 {amount} AI 额度",
			remaining: "剩余 {amount}",
			renews: "续订日期：{date}",
			ends: "可用至 {date}",
			pending: "正在确认订阅…",
			retry: "重试",
			close: "关闭",
			unavailable: "无法加载你的方案，请重试。",
			actionFailed: "无法打开支付页面，请重试。",
			portalFailed: "无法打开订阅设置，请重试。",
			active: "当前方案",
			paymentDue: "更新付款方式",
			paused: "已暂停",
			canceled: "已取消",
			taxes: "税费在结账时计算。",
			continue: "继续结账",
			browser: "打开账户"
		},
		ar: {
			opening: "جارٍ فتح صفحة الدفع الآمنة…",
			title: "خطتك",
			free: "مجاني",
			plus: "Plus",
			freeCopy: "تظل النماذج المحلية ومفاتيح API الخاصة بك مجانية دائمًا. للذكاء الاصطناعي السحابي حدود استخدام. لا اشتراك ولا بطاقة مطلوبة. تكاليف الأجهزة والجهات الموفرة منفصلة.",
			plusCopy: "المزيد من الذكاء الاصطناعي السحابي بميزانية شهرية محددة. احتفظ بمحادثاتك ونماذجك، وألغِ الاشتراك متى شئت.",
			month: "/ شهر",
			getPlus: "اشترك في Plus",
			manage: "إدارة الاشتراك",
			cancel: "إلغاء الاشتراك",
			allowance: "ميزانية شهرية للذكاء الاصطناعي: {amount}",
			remaining: "المتبقي {amount}",
			renews: "يتجدد في {date}",
			ends: "متاح حتى {date}",
			pending: "جارٍ تأكيد اشتراكك…",
			retry: "إعادة المحاولة",
			close: "إغلاق",
			unavailable: "تعذّر تحميل خطتك. حاول مجددًا.",
			actionFailed: "تعذّر فتح صفحة الدفع. حاول مجددًا.",
			portalFailed: "تعذّر فتح إعدادات الاشتراك. حاول مجددًا.",
			active: "الخطة الحالية",
			paymentDue: "تحديث الدفع",
			paused: "متوقف مؤقتًا",
			canceled: "ملغى",
			taxes: "تُحسب الضرائب عند الدفع.",
			continue: "المتابعة إلى الدفع",
			browser: "فتح حسابك"
		}
	};
	function subscriptionLabel(locale, key, values = {}) {
		return {
			...copy[locale] ?? en$1,
			...checkoutCopy[locale] ?? checkoutCopy.en
		}[key].replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/preferences.ts
	const PREFS_STORAGE_KEY = "uptokey.prefs.v1";
	const LEGACY_THEME_KEYS = [
		"quimera-theme",
		"uptokey_theme",
		"uptokey-theme"
	];
	const LEGACY_LANG_KEYS = ["quimera.lang.v1", "uptokey_locale"];
	const LOCALE_COOKIE = "uptokey_locale";
	const SUPPORTED_LANGS$1 = [
		"en",
		"pt-BR",
		"es",
		"fr",
		"de",
		"it",
		"ja",
		"ko",
		"zh-CN",
		"ar"
	];
	function canUseStorage() {
		try {
			const k = "__uptokey_prefs_probe__";
			localStorage.setItem(k, "1");
			localStorage.removeItem(k);
			return true;
		} catch {
			return false;
		}
	}
	function readCookie(name) {
		if (typeof document === "undefined") return null;
		const hit = document.cookie.split(";").map((e) => e.trim()).find((e) => e.startsWith(`${name}=`));
		if (!hit) return null;
		try {
			return decodeURIComponent(hit.slice(name.length + 1));
		} catch {
			return hit.slice(name.length + 1);
		}
	}
	function normalizeLocale(value) {
		const raw = String(value || "").trim();
		if (SUPPORTED_LANGS$1.includes(raw)) return raw;
		const lower = raw.toLowerCase();
		if (lower.startsWith("pt")) return "pt-BR";
		if (lower.startsWith("zh")) return "zh-CN";
		if (lower.startsWith("es")) return "es";
		if (lower.startsWith("fr")) return "fr";
		if (lower.startsWith("de")) return "de";
		if (lower.startsWith("it")) return "it";
		if (lower.startsWith("ja")) return "ja";
		if (lower.startsWith("ko")) return "ko";
		if (lower.startsWith("ar")) return "ar";
		if (lower.startsWith("en")) return "en";
		return null;
	}
	function migrateLegacy() {
		const out = {};
		if (!canUseStorage()) return out;
		try {
			for (const key of LEGACY_THEME_KEYS) {
				const v = localStorage.getItem(key);
				if (v === "light" || v === "dark" || v === "auto") {
					out.theme = v;
					break;
				}
			}
			for (const key of LEGACY_LANG_KEYS) {
				const v = normalizeLocale(localStorage.getItem(key));
				if (v) {
					out.locale = v;
					out.localeExplicit = true;
					break;
				}
			}
			if (!out.locale) {
				const cookieLang = normalizeLocale(readCookie(LOCALE_COOKIE));
				if (cookieLang) {
					out.locale = cookieLang;
					out.localeExplicit = true;
				}
			}
		} catch {}
		return out;
	}
	function readLocalPreferences() {
		const migrated = migrateLegacy();
		let stored = null;
		if (canUseStorage()) try {
			const raw = localStorage.getItem(PREFS_STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === 1) stored = parsed;
			}
		} catch {
			stored = null;
		}
		return {
			schemaVersion: 1,
			theme: stored?.theme ?? migrated.theme ?? "dark",
			locale: stored?.locale ?? migrated.locale,
			localeExplicit: stored?.localeExplicit ?? migrated.localeExplicit ?? Boolean(stored?.locale || migrated.locale),
			panelState: stored?.panelState ?? migrated.panelState,
			accessibility: stored?.accessibility,
			loggingIncludeContent: stored?.loggingIncludeContent ?? true,
			notificationSettings: stored?.notificationSettings
		};
	}
	/**
	* Precedência E2-23: explícita > (perfil sync injetado) > migrado já em read >
	* browser > en. Timezone guess is optional suggestion only when localeAuto.
	*/
	function resolveLocalePreference(options) {
		const prefs = readLocalPreferences();
		if (prefs.localeExplicit && prefs.locale) return prefs.locale;
		const synced = normalizeLocale(options?.syncedLocale);
		if (synced) return synced;
		return "en";
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/usage-observability-i18n.ts
	const USO_LANGS = [
		"en",
		"pt-BR",
		"es",
		"fr",
		"de",
		"it",
		"ja",
		"ko",
		"zh-CN",
		"ar"
	];
	const en = {
		uso_title: "Usage and observability",
		uso_tokens_unknown: "Unknown tokens",
		uso_estimated_not_charge: "Estimated reference — not a charge",
		uso_destinations_unavailable: "Destination unavailable",
		uso_private_logging_off: "Private content logging is off",
		uso_export: "Export usage",
		uso_empty: "No usage rows in this range",
		uso_loading: "Loading usage…",
		uso_error: "Could not load usage observability",
		uso_refresh: "Refresh usage",
		uso_query: "Usage summary",
		uso_detail: "Run detail",
		obs_console: "Observability console",
		obs_destinations: "Destinations",
		obs_logging: "Private logging"
	};
	const USO_DICT = {
		en,
		"pt-BR": {
			...en,
			uso_title: "Uso e observabilidade",
			uso_tokens_unknown: "Tokens desconhecidos",
			uso_estimated_not_charge: "Referência estimada — não é cobrança",
			uso_destinations_unavailable: "Destino indisponível",
			uso_private_logging_off: "Logging privado de conteúdo desligado",
			uso_export: "Exportar uso",
			uso_empty: "Nenhuma linha de uso neste intervalo",
			uso_loading: "Carregando uso…",
			uso_error: "Não foi possível carregar observabilidade de uso",
			uso_refresh: "Atualizar uso",
			uso_query: "Resumo de uso",
			uso_detail: "Detalhe da execução",
			obs_console: "Console de observabilidade",
			obs_destinations: "Destinos",
			obs_logging: "Logging privado"
		},
		es: {
			...en,
			uso_title: "Uso y observabilidad",
			uso_tokens_unknown: "Tokens desconocidos",
			uso_estimated_not_charge: "Referencia estimada — no es un cargo",
			uso_destinations_unavailable: "Destino no disponible",
			uso_private_logging_off: "El registro privado de contenido está desactivado",
			uso_export: "Exportar uso",
			uso_empty: "Sin filas de uso en este rango",
			uso_loading: "Cargando uso…",
			uso_error: "No se pudo cargar la observabilidad de uso",
			uso_refresh: "Actualizar uso",
			uso_query: "Resumen de uso",
			uso_detail: "Detalle de ejecución",
			obs_console: "Consola de observabilidad",
			obs_destinations: "Destinos",
			obs_logging: "Registro privado"
		},
		fr: {
			...en,
			uso_title: "Usage et observabilité",
			uso_tokens_unknown: "Jetons inconnus",
			uso_estimated_not_charge: "Référence estimée — pas une facturation",
			uso_destinations_unavailable: "Destination indisponible",
			uso_private_logging_off: "Journalisation privée du contenu désactivée",
			uso_export: "Exporter l’usage",
			uso_empty: "Aucune ligne d’usage dans cette plage",
			uso_loading: "Chargement de l’usage…",
			uso_error: "Impossible de charger l’observabilité d’usage",
			uso_refresh: "Actualiser l’usage",
			uso_query: "Résumé d’usage",
			uso_detail: "Détail d’exécution",
			obs_console: "Console d’observabilité",
			obs_destinations: "Destinations",
			obs_logging: "Journalisation privée"
		},
		de: {
			...en,
			uso_title: "Nutzung und Observability",
			uso_tokens_unknown: "Unbekannte Tokens",
			uso_estimated_not_charge: "Geschätzte Referenz — keine Abbuchung",
			uso_destinations_unavailable: "Ziel nicht verfügbar",
			uso_private_logging_off: "Private Inhaltsprotokollierung ist aus",
			uso_export: "Nutzung exportieren",
			uso_empty: "Keine Nutzungszeilen in diesem Zeitraum",
			uso_loading: "Nutzung wird geladen…",
			uso_error: "Nutzungs-Observability konnte nicht geladen werden",
			uso_refresh: "Nutzung aktualisieren",
			uso_query: "Nutzungsübersicht",
			uso_detail: "Laufdetail",
			obs_console: "Observability-Konsole",
			obs_destinations: "Ziele",
			obs_logging: "Private Protokollierung"
		},
		it: {
			...en,
			uso_title: "Uso e osservabilità",
			uso_tokens_unknown: "Token sconosciuti",
			uso_estimated_not_charge: "Riferimento stimato — non è un addebito",
			uso_destinations_unavailable: "Destinazione non disponibile",
			uso_private_logging_off: "Logging privato dei contenuti disattivato",
			uso_export: "Esporta uso",
			uso_empty: "Nessuna riga di uso in questo intervallo",
			uso_loading: "Caricamento uso…",
			uso_error: "Impossibile caricare l’osservabilità dell’uso",
			uso_refresh: "Aggiorna uso",
			uso_query: "Riepilogo uso",
			uso_detail: "Dettaglio esecuzione",
			obs_console: "Console di osservabilità",
			obs_destinations: "Destinazioni",
			obs_logging: "Logging privato"
		},
		ja: {
			...en,
			uso_title: "利用状況とオブザーバビリティ",
			uso_tokens_unknown: "不明なトークン",
			uso_estimated_not_charge: "推定参考値 — 課金ではありません",
			uso_destinations_unavailable: "送信先は利用できません",
			uso_private_logging_off: "プライベートコンテンツログはオフです",
			uso_export: "利用状況をエクスポート",
			uso_empty: "この範囲に利用行はありません",
			uso_loading: "利用状況を読み込み中…",
			uso_error: "利用オブザーバビリティを読み込めませんでした",
			uso_refresh: "利用状況を更新",
			uso_query: "利用サマリー",
			uso_detail: "実行の詳細",
			obs_console: "オブザーバビリティコンソール",
			obs_destinations: "送信先",
			obs_logging: "プライベートログ"
		},
		ko: {
			...en,
			uso_title: "사용량 및 관찰 가능성",
			uso_tokens_unknown: "알 수 없는 토큰",
			uso_estimated_not_charge: "추정 참고값 — 청구가 아님",
			uso_destinations_unavailable: "대상을 사용할 수 없음",
			uso_private_logging_off: "비공개 콘텐츠 로깅이 꺼져 있음",
			uso_export: "사용량 내보내기",
			uso_empty: "이 범위에 사용량 행이 없음",
			uso_loading: "사용량 불러오는 중…",
			uso_error: "사용량 관찰 가능성을 불러올 수 없음",
			uso_refresh: "사용량 새로고침",
			uso_query: "사용량 요약",
			uso_detail: "실행 상세",
			obs_console: "관찰 가능성 콘솔",
			obs_destinations: "대상",
			obs_logging: "비공개 로깅"
		},
		"zh-CN": {
			...en,
			uso_title: "用量与可观测性",
			uso_tokens_unknown: "未知令牌",
			uso_estimated_not_charge: "估算参考值 — 不是扣费",
			uso_destinations_unavailable: "目标不可用",
			uso_private_logging_off: "私有内容日志已关闭",
			uso_export: "导出用量",
			uso_empty: "此范围内没有用量行",
			uso_loading: "正在加载用量…",
			uso_error: "无法加载用量可观测性",
			uso_refresh: "刷新用量",
			uso_query: "用量摘要",
			uso_detail: "运行详情",
			obs_console: "可观测性控制台",
			obs_destinations: "目标",
			obs_logging: "私有日志"
		},
		ar: {
			...en,
			uso_title: "الاستخدام والمراقبة",
			uso_tokens_unknown: "رموز غير معروفة",
			uso_estimated_not_charge: "مرجع تقديري — ليس رسماً",
			uso_destinations_unavailable: "الوجهة غير متاحة",
			uso_private_logging_off: "تسجيل المحتوى الخاص متوقف",
			uso_export: "تصدير الاستخدام",
			uso_empty: "لا توجد صفوف استخدام في هذا النطاق",
			uso_loading: "جارٍ تحميل الاستخدام…",
			uso_error: "تعذر تحميل مراقبة الاستخدام",
			uso_refresh: "تحديث الاستخدام",
			uso_query: "ملخص الاستخدام",
			uso_detail: "تفاصيل التشغيل",
			obs_console: "وحدة مراقبة",
			obs_destinations: "الوجهات",
			obs_logging: "التسجيل الخاص"
		}
	};
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/master-i18n-dict.ts
	const MASTER_I18N_NAMESPACED = {
		"pt-BR": {
			common: {
				ok: "OK",
				cancel: "Cancelar",
				save: "Salvar",
				back: "Voltar",
				confirm: "Confirmar",
				undo: "Desfazer"
			},
			shell: {
				proxy_connected: "Proxy Local Conectado",
				proxy_degraded: "Proxy Local Indisponível",
				select_model: "Selecionar Modelo Virtual",
				new_chat: "Nova Conversa"
			},
			composer: {
				placeholder: "Digite uma instrução ou mensagem...",
				recording_audio: "Ouvindo... Fale agora",
				transcribing: "Processando transcrição local...",
				attach_file: "Anexar Arquivo",
				link_folder: "Vincular Pasta do Projeto"
			},
			chat: {
				streaming_tokens: "Gerando resposta...",
				stop_generation: "Interromper Geração",
				view_details: "Ver Detalhes Técnicos",
				hide_details: "Ocultar Detalhes"
			},
			w5: {
				consent_title: "Solicitação de Alteração de Arquivo (Governança W5)",
				approve_change: "Aprovar Alteração",
				reject_change: "Rejeitar Alteração",
				diff_additions: "{count, plural, one {# adição} other {# adições}}",
				diff_deletions: "{count, plural, one {# remoção} other {# remoções}}"
			},
			modals: {
				quota_panel_title: "Consumo e Teto Orçamentário",
				endpoint_panel_title: "Cofre de Chaves de API (BYOK)",
				capability_title: "Catálogo de Ferramentas e Servidores MCP"
			},
			errors: {
				network_unavailable: "Serviço temporariamente indisponível. Verifique sua conexão local.",
				quota_exceeded: "Teto orçamentário atingido para o período atual.",
				key_expired: "A chave de API configurada no cofre do SO expirou ou é inválida.",
				api_failed: "A chamada ao serviço externo falhou. Clique em 'Detalhes' para ações recomendadas."
			},
			privacy: {
				"privacy_title": "Privacidade e dados",
				"privacy_hint": "Preferências e exportações do serviço local. A retenção pelo provedor de IA é definida pelo provedor.",
				"privacy_include_exports": "Incluir mensagens nas exportações",
				"privacy_notifications": "Notificações no navegador",
				"privacy_quiet_hours": "Horário silencioso",
				"privacy_quiet_start": "Início",
				"privacy_quiet_end": "Fim",
				"privacy_quiet_zone": "Fuso",
				"privacy_save_quiet": "Salvar horário",
				"privacy_clear_quiet": "Remover horário",
				"privacy_export_prefs": "Exportar preferências",
				"privacy_export_conversation": "Exportar conversa atual",
				"privacy_export_receipts": "Exportar recibos locais",
				"privacy_files_title": "Arquivos gerados e recibos locais",
				"privacy_files_note": "Referências e execuções ativas impedem exclusão. A identidade das execuções permanece para evitar repetição de operações. Cópias exportadas e registros externos têm retenção própria.",
				"privacy_resource": "Recurso",
				"privacy_select": "Selecionar",
				"privacy_confirm_resource": "Confirmo a exclusão do recurso selecionado",
				"privacy_delete_resource": "Excluir recurso",
				"privacy_conversation_title": "Excluir conversa atual do armazenamento local",
				"privacy_conversation_note": "A exclusão apaga esta conversa no serviço local. Não apaga cópias ou registros de provedores externos.",
				"privacy_confirm_conversation": "Confirmo a exclusão desta conversa",
				"privacy_delete_conversation": "Excluir conversa",
				"privacy_download": "Baixar resultado",
				"privacy_delete_export": "Apagar esta exportação do serviço",
				"privacy_refresh_result": "Consultar resultado",
				"privacy_refresh": "Atualizar",
				"privacy_loading": "Carregando…",
				"privacy_blocked_prefix": "Não é possível excluir agora: ",
				"err_privacy_unavailable": "Não foi possível carregar as configurações de privacidade. Tente novamente.",
				"err_privacy_invalid": "O serviço local devolveu dados inesperados. Atualize a página e tente novamente.",
				"err_privacy_export": "Não foi possível exportar agora. Confira o estado do serviço e tente novamente.",
				"err_privacy_job": "Esta operação não está mais disponível. Inicie-a novamente.",
				"err_privacy_retention": "Este item não pode ser excluído enquanto houver referências ou execuções ativas.",
				"privacy_job_kind_export": "Exportação",
				"privacy_job_state_completed": "concluída",
				"privacy_job_state_processing": "em processamento",
				"privacy_job_state_failed": "falhou",
				"privacy_class_artifact": "Arquivo gerado",
				"privacy_class_receipts": "Recibos locais",
				"privacy_blocked_unknown": "Não foi possível excluir agora. O motivo técnico está recolhido abaixo.",
				"privacy_job_kind_purge": "Exclusão",
				"privacy_job_state_cancelled": "cancelada",
				"privacy_class_export": "Exportação armazenada",
				"privacy_unknown_value": "Valor desconhecido (detalhe recolhido)"
			},
			media: {
				"media_connect_service": "Conecte um serviço compatível para continuar.",
				"media_connect_button": "Conectar serviço",
				"media_prepare_error": "Não foi possível preparar a operação. Nenhuma execução foi autorizada.",
				"media_activate_error": "Não foi possível ativar o serviço. Confira o modelo, o endpoint e a conexão.",
				"media_model": "Modelo",
				"media_endpoint": "Endpoint",
				"media_reference_url": "URL HTTPS pública de uma origem autorizada no proxy. O provedor buscará essa imagem após seu consentimento.",
				"media_local_reference_title": "Arquivo local como referência",
				"media_local_reference_note": "O driver utiliza uma URL HTTPS pública. Ele não publica arquivos locais. Para usar uma imagem inicial, configure o suporte a frame_images e a origem pública permitida no perfil de vídeo.",
				"media_hint_image": "Essa credencial será usada para geração de imagem. Escolha o provedor que oferece esse recurso; a geração continua exigindo sua autorização.",
				"media_hint_video": "Essa credencial será usada para geração de vídeo. Escolha o provedor que oferece esse recurso; a geração continua exigindo sua autorização.",
				"media_hint_speech": "Essa credencial será usada para texto em voz. Escolha o provedor que oferece esse recurso; a geração continua exigindo sua autorização.",
				"media_hint_transcription": "Essa credencial será usada para transcrição de áudio. Escolha o provedor que oferece esse recurso; a geração continua exigindo sua autorização.",
				"media_load_error": "Não foi possível carregar o serviço ou recuperar a operação. Tente novamente.",
				"media_processing_denied": "Ative o processamento pelo provedor nesta conversa para usar este serviço.",
				"media_result_recover_error": "Não foi possível recuperar este resultado.",
				"media_try_again": "Tentar novamente",
				"media_loading_result": "Carregando resultado…",
				"media_output_invalid": "O arquivo recebido não passou pela verificação de mídia. O destino foi preservado; tente gerar o resultado novamente.",
				"media_output_timeout": "A verificação de mídia excedeu o tempo disponível. O destino foi preservado; tente salvar novamente.",
				"media_save_error": "Não foi possível salvar o arquivo. O resultado continua disponível para download.",
				"media_loading": "Carregando…",
				"media_result_mismatch": "O resultado não corresponde aos recibos desta operação. Atualize o estado antes de usar o arquivo.",
				"media_refresh": "Atualizar serviço",
				"media_cancelled": "Operação cancelada",
				"media_cancel": "Cancelar operação",
				"media_local_only": "O processamento desta conversa está limitado ao dispositivo. Serviços externos exigem alterar essa opção no chat.",
				"media_reference_image": "Imagem de referência",
				"media_initial_image_url": "URL da imagem inicial",
				"media_text_only_note": "O serviço conectado oferece geração por texto. Referências exigem configurar um endpoint de edição compatível.",
				"media_kept_for_recovery": "Operação mantida para recuperação. Atualize seu estado antes de preparar outra.",
				"media_reconnect": "A operação precisa ser reconectada. Não reenvie o pedido.",
				"media_file_saved": "Arquivo salvo",
				"media_saving": "Salvando…",
				"media_save_file": "Salvar em {name}",
				"media_kind_image": "Imagem",
				"media_kind_video": "Vídeo",
				"media_kind_speech": "Voz",
				"media_kind_transcription": "Transcrição",
				"media_project_edit": "Editar imagem",
				"media_transcript_note": "A continuidade usa esta transcrição quando ela estiver selecionada no contexto. O áudio original permanece salvo; seus bytes não são enviados novamente nesse caso.",
				"media_transcript_meta": "Transcrição vinculada ao áudio original · continuidade por texto quando selecionada no contexto",
				"media_result_preserved": "O resultado está preservado. Atualize a operação para concluir o vínculo com a conversa, sem executar novamente.",
				"media_output_format_mismatch": "O formato recebido difere do destino escolhido. Baixe o resultado no formato original.",
				"media_output_decoder_unavailable": "Este navegador não consegue verificar o formato recebido. O destino foi preservado; você pode baixar o original.",
				"media_run_status_unknown": "estado não confirmado",
				"media_run_status_succeeded": "concluído",
				"media_run_status_failed": "falhou",
				"media_run_status_running": "em execução",
				"media_run_status_cancelled": "cancelado",
				"media_run_status_awaiting": "aguardando autorização",
				"media_run_status_needs_attention": "precisa de atenção",
				"media_known_provider": "Provedor conhecido",
				"media_select_provider": "Escolher provedor",
				"media_manage_accounts": "Gerenciar contas",
				"media_account_configured": "conta configurada",
				"media_no_image_provider": "Nenhum provedor conhecido declara geração de imagem ainda. Gerencie contas ou use um endpoint manual compatível.",
				"media_destination": "Destino: {name}",
				"media_remove": "Remover"
			},
			sensitive: {
				"sensitive_title": "Entrada segura no cofre local",
				"sensitive_instruction_label": "Configurando credencial para {label}. ",
				"sensitive_note": "O valor é transmitido apenas ao cofre local do proxy e nunca é gravado no histórico, na tela ou na exportação.",
				"sensitive_secret_label": "Chave de acesso / Segredo",
				"sensitive_secret_placeholder": "Cole aqui a chave de acesso…",
				"sensitive_saving": "Salvando…",
				"sensitive_retry": "Tentar novamente",
				"sensitive_save": "Salvar no cofre",
				"sensitive_cancel": "Cancelar",
				"sensitive_aria": "Entrada segura de credencial",
				"sensitive_connection_fallback": "Conexão {provider}",
				"sensitive_error_default": "O proxy recusou a credencial. Consulte o código abaixo e tente novamente.",
				"err_sensitive_target_missing": "Nenhuma conexão ou provedor foi indicado. Abra a configuração da conexão e escolha o destino da credencial.",
				"err_sensitive_revision_missing": "A revisão da conexão não foi informada. Reabra a conexão para usar o estado atual.",
				"err_sensitive_connection_id_invalid": "O identificador da conexão é inválido. Reabra a conexão pela lista.",
				"err_sensitive_provider_id_invalid": "O provedor indicado é inválido. Escolha o provedor pela lista.",
				"err_sensitive_revision_conflict": "A conexão mudou desde que foi aberta. Reabra-a para usar a revisão atual.",
				"err_sensitive_connection_not_found": "A conexão não existe mais. Atualize a lista de conexões.",
				"err_sensitive_unauthorized": "A sessão local expirou ou foi revogada. Reconecte ao proxy local e tente novamente.",
				"err_sensitive_rate_limited": "Muitas alterações em pouco tempo. Aguarde um instante e tente novamente.",
				"err_sensitive_limit_exceeded": "O limite de conexões foi atingido. Remova uma conexão antes de criar outra.",
				"err_sensitive_multiconta_disabled": "Várias contas para o mesmo provedor estão desativadas. Use a conexão existente.",
				"err_sensitive_invalid_profile": "O proxy recusou os dados da conexão. Revise o provedor e a chave informada.",
				"err_sensitive_invalid_request": "O proxy recusou a solicitação. Revise a chave informada.",
				"err_sensitive_confirmation_invalid": "O proxy não confirmou a gravação desta conexão. Nada foi marcado como salvo; atualize a lista antes de tentar de novo.",
				"err_sensitive_interrupted": "A conexão com o proxy caiu antes da confirmação. Tentar novamente reutiliza a mesma operação, sem duplicar."
			}
		},
		en: {
			common: {
				ok: "OK",
				cancel: "Cancel",
				save: "Save",
				back: "Back",
				confirm: "Confirm",
				undo: "Undo"
			},
			shell: {
				proxy_connected: "Local Proxy Connected",
				proxy_degraded: "Local Proxy Offline",
				select_model: "Select Virtual Model",
				new_chat: "New Conversation"
			},
			composer: {
				placeholder: "Type an instruction or message...",
				recording_audio: "Listening... Speak now",
				transcribing: "Processing local transcription...",
				attach_file: "Attach File",
				link_folder: "Link Project Folder"
			},
			chat: {
				streaming_tokens: "Generating response...",
				stop_generation: "Stop Generation",
				view_details: "View Technical Details",
				hide_details: "Hide Details"
			},
			w5: {
				consent_title: "File Change Request (W5 Governance)",
				approve_change: "Approve Change",
				reject_change: "Reject Change",
				diff_additions: "{count, plural, one {# addition} other {# additions}}",
				diff_deletions: "{count, plural, one {# deletion} other {# deletions}}"
			},
			modals: {
				quota_panel_title: "Usage & Budget Ceiling",
				endpoint_panel_title: "API Keys Vault (BYOK)",
				capability_title: "Tools & MCP Server Catalog"
			},
			errors: {
				network_unavailable: "Service temporarily unavailable. Check your local connection.",
				quota_exceeded: "Budget ceiling reached for the current period.",
				key_expired: "The API key configured in OS vault has expired or is invalid.",
				api_failed: "External service call failed. Click 'Details' for recommended actions."
			},
			privacy: {
				"privacy_title": "Privacy and data",
				"privacy_hint": "Local service preferences and exports. AI provider retention is controlled by the provider.",
				"privacy_include_exports": "Include message content in exports",
				"privacy_notifications": "Browser notifications",
				"privacy_quiet_hours": "Quiet hours",
				"privacy_quiet_start": "Start",
				"privacy_quiet_end": "End",
				"privacy_quiet_zone": "Timezone",
				"privacy_save_quiet": "Save quiet hours",
				"privacy_clear_quiet": "Clear quiet hours",
				"privacy_export_prefs": "Export preferences",
				"privacy_export_conversation": "Export current conversation",
				"privacy_export_receipts": "Export local receipts",
				"privacy_files_title": "Generated files and local receipts",
				"privacy_files_note": "References and active executions prevent deletion. Execution identities remain to prevent duplicate operations. Exported copies and external records have their own retention.",
				"privacy_resource": "Resource",
				"privacy_select": "Select",
				"privacy_confirm_resource": "I confirm deletion of the selected resource",
				"privacy_delete_resource": "Delete resource",
				"privacy_conversation_title": "Delete current conversation from local storage",
				"privacy_conversation_note": "Deletion removes this conversation from the local service. It does not delete copies or records held by external providers.",
				"privacy_confirm_conversation": "I confirm deletion of this conversation",
				"privacy_delete_conversation": "Delete conversation",
				"privacy_download": "Download result",
				"privacy_delete_export": "Delete this stored export",
				"privacy_refresh_result": "Refresh result",
				"privacy_refresh": "Refresh",
				"privacy_loading": "Loading…",
				"privacy_blocked_prefix": "Cannot delete right now: ",
				"err_privacy_unavailable": "Could not load privacy settings. Try again.",
				"err_privacy_invalid": "The local service returned unexpected data. Reload the page and try again.",
				"err_privacy_export": "Could not export right now. Check the service state and try again.",
				"err_privacy_job": "This operation is no longer available. Start it again.",
				"err_privacy_retention": "This item cannot be deleted while references or active executions exist.",
				"privacy_job_kind_export": "Export",
				"privacy_job_state_completed": "completed",
				"privacy_job_state_processing": "processing",
				"privacy_job_state_failed": "failed",
				"privacy_class_artifact": "Generated file",
				"privacy_class_receipts": "Local receipts",
				"privacy_blocked_unknown": "Could not delete right now. The technical reason is collapsed below.",
				"privacy_job_kind_purge": "Deletion",
				"privacy_job_state_cancelled": "cancelled",
				"privacy_class_export": "Stored export",
				"privacy_unknown_value": "Unknown value (detail collapsed)"
			},
			media: {
				"media_connect_service": "Connect a compatible service to continue.",
				"media_connect_button": "Connect service",
				"media_prepare_error": "Could not prepare the operation. Nothing was executed.",
				"media_activate_error": "Could not enable the service. Check the model, the endpoint and the connection.",
				"media_model": "Model",
				"media_endpoint": "Endpoint",
				"media_reference_url": "Public HTTPS URL from an origin authorized in the proxy. The provider will fetch that image after your consent.",
				"media_local_reference_title": "Local file as reference",
				"media_local_reference_note": "The driver uses a public HTTPS URL. It does not publish local files. To use an initial image, configure frame_images support and the allowed public origin in the video profile.",
				"media_hint_image": "This credential will be used for image generation. Choose a provider that offers it; generation still requires your authorization.",
				"media_hint_video": "This credential will be used for video generation. Choose a provider that offers it; generation still requires your authorization.",
				"media_hint_speech": "This credential will be used for text to speech. Choose a provider that offers it; generation still requires your authorization.",
				"media_hint_transcription": "This credential will be used for audio transcription. Choose a provider that offers it; generation still requires your authorization.",
				"media_load_error": "Could not load the service or recover the operation. Try again.",
				"media_processing_denied": "Enable provider processing for this conversation to use this service.",
				"media_result_recover_error": "Could not recover this result.",
				"media_try_again": "Try again",
				"media_loading_result": "Loading result…",
				"media_output_invalid": "The received file failed media verification. The destination was preserved; try generating the result again.",
				"media_output_timeout": "Media verification exceeded the available time. The destination was preserved; try saving again.",
				"media_save_error": "Could not save the file. The result remains available for download.",
				"media_loading": "Loading…",
				"media_result_mismatch": "The result does not match this operation’s receipts. Refresh the state before using the file.",
				"media_refresh": "Refresh service",
				"media_cancelled": "Operation cancelled",
				"media_cancel": "Cancel operation",
				"media_local_only": "This conversation’s processing is limited to this device. External services require changing that option in the chat.",
				"media_reference_image": "Reference image",
				"media_initial_image_url": "Initial image URL",
				"media_text_only_note": "The connected service offers text generation. References require configuring a compatible editing endpoint.",
				"media_kept_for_recovery": "Operation kept for recovery. Refresh your state before preparing another.",
				"media_reconnect": "The operation needs reconnecting. Do not resend the request.",
				"media_file_saved": "File saved",
				"media_saving": "Saving…",
				"media_save_file": "Save to {name}",
				"media_kind_image": "Image",
				"media_kind_video": "Video",
				"media_kind_speech": "Speech",
				"media_kind_transcription": "Transcription",
				"media_project_edit": "Edit image",
				"media_transcript_note": "Continuation uses this transcript when selected in context. The original audio stays saved; its bytes are not sent again in that case.",
				"media_transcript_meta": "Transcript linked to original audio · text continuation when selected in context",
				"media_result_preserved": "The result is preserved. Refresh the operation to complete the conversation link without running again.",
				"media_output_format_mismatch": "The received format differs from the chosen destination. Download the result in its original format.",
				"media_output_decoder_unavailable": "This browser cannot verify the received format. The destination was preserved; you can download the original.",
				"media_run_status_unknown": "state not confirmed",
				"media_run_status_succeeded": "completed",
				"media_run_status_failed": "failed",
				"media_run_status_running": "running",
				"media_run_status_cancelled": "cancelled",
				"media_run_status_awaiting": "awaiting authorization",
				"media_run_status_needs_attention": "needs attention",
				"media_known_provider": "Known provider",
				"media_select_provider": "Choose provider",
				"media_manage_accounts": "Manage accounts",
				"media_account_configured": "account configured",
				"media_no_image_provider": "No known provider declares image generation yet. Manage accounts or use a compatible manual endpoint.",
				"media_destination": "Destination: {name}",
				"media_remove": "Remove"
			},
			sensitive: {
				"sensitive_title": "Secure entry into the local vault",
				"sensitive_instruction_label": "Setting up a credential for {label}. ",
				"sensitive_note": "The value is sent only to the local proxy vault and is never written to history, the screen, or exports.",
				"sensitive_secret_label": "Access key / Secret",
				"sensitive_secret_placeholder": "Paste the access key here…",
				"sensitive_saving": "Saving…",
				"sensitive_retry": "Try again",
				"sensitive_save": "Save to vault",
				"sensitive_cancel": "Cancel",
				"sensitive_aria": "Secure credential entry",
				"sensitive_connection_fallback": "Connection {provider}",
				"sensitive_error_default": "The proxy rejected the credential. See the code below and try again.",
				"err_sensitive_target_missing": "No connection or provider was indicated. Open the connection settings and choose the credential destination.",
				"err_sensitive_revision_missing": "The connection revision was not provided. Reopen the connection to use the current state.",
				"err_sensitive_connection_id_invalid": "The connection identifier is invalid. Reopen the connection from the list.",
				"err_sensitive_provider_id_invalid": "The indicated provider is invalid. Choose the provider from the list.",
				"err_sensitive_revision_conflict": "The connection changed since it was opened. Reopen it to use the current revision.",
				"err_sensitive_connection_not_found": "The connection no longer exists. Refresh the connection list.",
				"err_sensitive_unauthorized": "The local session expired or was revoked. Reconnect to the local proxy and try again.",
				"err_sensitive_rate_limited": "Too many changes in a short time. Wait a moment and try again.",
				"err_sensitive_limit_exceeded": "The connection limit was reached. Remove a connection before creating another.",
				"err_sensitive_multiconta_disabled": "Multiple accounts for the same provider are disabled. Use the existing connection.",
				"err_sensitive_invalid_profile": "The proxy rejected the connection data. Review the provider and the provided key.",
				"err_sensitive_invalid_request": "The proxy rejected the request. Review the provided key.",
				"err_sensitive_confirmation_invalid": "The proxy did not confirm this connection write. Nothing was marked as saved; refresh the list before retrying.",
				"err_sensitive_interrupted": "The proxy connection dropped before confirmation. Retrying reuses the same operation without duplicating."
			}
		},
		es: {
			common: {
				ok: "Aceptar",
				cancel: "Cancelar",
				save: "Guardar",
				back: "Volver",
				confirm: "Confirmar",
				undo: "Deshacer"
			},
			shell: {
				proxy_connected: "Proxy Local Conectado",
				proxy_degraded: "Proxy Local Desconectado",
				select_model: "Seleccionar Modelo Virtual",
				new_chat: "Nueva Conversación"
			},
			composer: {
				placeholder: "Escriba una instrucción o mensaje...",
				recording_audio: "Escuchando... Hable ahora",
				transcribing: "Procesando transcripción local...",
				attach_file: "Adjuntar Archivo",
				link_folder: "Vincular Carpeta del Proyecto"
			},
			chat: {
				streaming_tokens: "Generando respuesta...",
				stop_generation: "Detener Generación",
				view_details: "Ver Detalles Técnicos",
				hide_details: "Ocultar Detalles"
			},
			w5: {
				consent_title: "Solicitud de Cambio de Archivo (Gobernanza W5)",
				approve_change: "Aprobar Cambio",
				reject_change: "Rechazar Cambio",
				diff_additions: "{count, plural, one {# adición} other {# adiciones}}",
				diff_deletions: "{count, plural, one {# eliminación} other {# eliminaciones}}"
			},
			modals: {
				quota_panel_title: "Uso y Límite Presupuestario",
				endpoint_panel_title: "Bóveda de Claves de API (BYOK)",
				capability_title: "Catálogo de Herramientas y Servidores MCP"
			},
			errors: {
				network_unavailable: "Servicio temporalmente no disponible. Verifique su conexión local.",
				quota_exceeded: "Límite presupuestario alcanzado para el período actual.",
				key_expired: "La clave de API configurada en la bóveda del S.O. ha expirado o no es válida.",
				api_failed: "La llamada al servicio externo falló. Haga clic en 'Detalles' para acciones recomendadas."
			},
			privacy: {
				"privacy_title": "Privacidad y datos",
				"privacy_hint": "Preferencias y exportaciones del servicio local. La retención del proveedor de IA la define el proveedor.",
				"privacy_include_exports": "Incluir mensajes en las exportaciones",
				"privacy_notifications": "Notificaciones del navegador",
				"privacy_quiet_hours": "Horario silencioso",
				"privacy_quiet_start": "Inicio",
				"privacy_quiet_end": "Fin",
				"privacy_quiet_zone": "Zona horaria",
				"privacy_save_quiet": "Guardar horario",
				"privacy_clear_quiet": "Eliminar horario",
				"privacy_export_prefs": "Exportar preferencias",
				"privacy_export_conversation": "Exportar conversación actual",
				"privacy_export_receipts": "Exportar recibos locales",
				"privacy_files_title": "Archivos generados y recibos locales",
				"privacy_files_note": "Las referencias y ejecuciones activas impiden la eliminación. La identidad de las ejecuciones se conserva para evitar operaciones duplicadas. Las copias exportadas y los registros externos tienen su propia retención.",
				"privacy_resource": "Recurso",
				"privacy_select": "Seleccionar",
				"privacy_confirm_resource": "Confirmo la eliminación del recurso seleccionado",
				"privacy_delete_resource": "Eliminar recurso",
				"privacy_conversation_title": "Eliminar la conversación actual del almacenamiento local",
				"privacy_conversation_note": "La eliminación borra esta conversación del servicio local. No borra copias ni registros de proveedores externos.",
				"privacy_confirm_conversation": "Confirmo la eliminación de esta conversación",
				"privacy_delete_conversation": "Eliminar conversación",
				"privacy_download": "Descargar resultado",
				"privacy_delete_export": "Eliminar esta exportación del servicio",
				"privacy_refresh_result": "Consultar resultado",
				"privacy_refresh": "Actualizar",
				"privacy_loading": "Cargando…",
				"privacy_blocked_prefix": "No se puede eliminar ahora: ",
				"err_privacy_unavailable": "No se pudieron cargar los ajustes de privacidad. Inténtelo de nuevo.",
				"err_privacy_invalid": "El servicio local devolvió datos inesperados. Recargue la página e inténtelo de nuevo.",
				"err_privacy_export": "No se pudo exportar ahora. Compruebe el estado del servicio e inténtelo de nuevo.",
				"err_privacy_job": "Esta operación ya no está disponible. Iníciela de nuevo.",
				"err_privacy_retention": "Este elemento no puede eliminarse mientras existan referencias o ejecuciones activas.",
				"privacy_job_kind_export": "Exportación",
				"privacy_job_state_completed": "completada",
				"privacy_job_state_processing": "en proceso",
				"privacy_job_state_failed": "fallida",
				"privacy_class_artifact": "Archivo generado",
				"privacy_class_receipts": "Recibos locales",
				"privacy_blocked_unknown": "No se pudo eliminar ahora. El motivo técnico está recogido abajo.",
				"privacy_job_kind_purge": "Eliminación",
				"privacy_job_state_cancelled": "cancelada",
				"privacy_class_export": "Exportación almacenada",
				"privacy_unknown_value": "Valor desconocido (detalle recogido)"
			},
			media: {
				"media_connect_service": "Conecte un servicio compatible para continuar.",
				"media_connect_button": "Conectar servicio",
				"media_prepare_error": "No se pudo preparar la operación. No se autorizó ninguna ejecución.",
				"media_activate_error": "No se pudo activar el servicio. Compruebe el modelo, el endpoint y la conexión.",
				"media_model": "Modelo",
				"media_endpoint": "Endpoint",
				"media_reference_url": "URL HTTPS pública de un origen autorizado en el proxy. El proveedor obtendrá esa imagen tras su consentimiento.",
				"media_local_reference_title": "Archivo local como referencia",
				"media_local_reference_note": "El controlador utiliza una URL HTTPS pública. No publica archivos locales. Para usar una imagen inicial, configure el soporte de frame_images y el origen público permitido en el perfil de vídeo.",
				"media_hint_image": "Esta credencial se usará para generar imágenes. Elija un proveedor que lo ofrezca; la generación sigue requiriendo su autorización.",
				"media_hint_video": "Esta credencial se usará para generar vídeo. Elija un proveedor que lo ofrezca; la generación sigue requiriendo su autorización.",
				"media_hint_speech": "Esta credencial se usará para texto a voz. Elija un proveedor que lo ofrezca; la generación sigue requiriendo su autorización.",
				"media_hint_transcription": "Esta credencial se usará para transcribir audio. Elija un proveedor que lo ofrezca; la generación sigue requiriendo su autorización.",
				"media_load_error": "No se pudo cargar el servicio ni recuperar la operación. Inténtelo de nuevo.",
				"media_processing_denied": "Active el procesamiento del proveedor en esta conversación para usar este servicio.",
				"media_result_recover_error": "No se pudo recuperar este resultado.",
				"media_try_again": "Intentar de nuevo",
				"media_loading_result": "Cargando resultado…",
				"media_output_invalid": "El archivo recibido no pasó la verificación de medios. El destino se conservó; intente generar el resultado de nuevo.",
				"media_output_timeout": "La verificación de medios excedió el tiempo disponible. El destino se conservó; intente guardar de nuevo.",
				"media_save_error": "No se pudo guardar el archivo. El resultado sigue disponible para descargar.",
				"media_loading": "Cargando…",
				"media_result_mismatch": "El resultado no coincide con los recibos de esta operación. Actualice el estado antes de usar el archivo.",
				"media_refresh": "Actualizar servicio",
				"media_cancelled": "Operación cancelada",
				"media_cancel": "Cancelar operación",
				"media_local_only": "El procesamiento de esta conversación está limitado a este dispositivo. Los servicios externos requieren cambiar esa opción en el chat.",
				"media_reference_image": "Imagen de referencia",
				"media_initial_image_url": "URL de la imagen inicial",
				"media_text_only_note": "El servicio conectado ofrece generación por texto. Las referencias requieren configurar un endpoint de edición compatible.",
				"media_kept_for_recovery": "Operación conservada para recuperación. Actualice su estado antes de preparar otra.",
				"media_reconnect": "La operación necesita reconectarse. No reenvíe la solicitud.",
				"media_file_saved": "Archivo guardado",
				"media_saving": "Guardando…",
				"media_save_file": "Guardar en {name}",
				"media_kind_image": "Imagen",
				"media_kind_video": "Vídeo",
				"media_kind_speech": "Voz",
				"media_kind_transcription": "Transcripción",
				"media_project_edit": "Editar imagen",
				"media_transcript_note": "La continuidad usa esta transcripción cuando está seleccionada en el contexto. El audio original permanece guardado; sus bytes no se reenvían en ese caso.",
				"media_transcript_meta": "Transcripción vinculada al audio original · continuidad por texto cuando está seleccionada en el contexto",
				"media_result_preserved": "El resultado está conservado. Actualice la operación para completar el vínculo con la conversación, sin ejecutar de nuevo.",
				"media_output_format_mismatch": "El formato recibido difiere del destino elegido. Descargue el resultado en su formato original.",
				"media_output_decoder_unavailable": "Este navegador no puede verificar el formato recibido. El destino se conservó; puede descargar el original.",
				"media_run_status_unknown": "estado no confirmado",
				"media_run_status_succeeded": "completado",
				"media_run_status_failed": "fallido",
				"media_run_status_running": "en ejecución",
				"media_run_status_cancelled": "cancelado",
				"media_run_status_awaiting": "esperando autorización",
				"media_run_status_needs_attention": "necesita atención",
				"media_known_provider": "Proveedor conocido",
				"media_select_provider": "Elegir proveedor",
				"media_manage_accounts": "Administrar cuentas",
				"media_account_configured": "cuenta configurada",
				"media_no_image_provider": "Ningún proveedor conocido declara generación de imágenes todavía. Administre cuentas o use un endpoint manual compatible.",
				"media_destination": "Destino: {name}",
				"media_remove": "Quitar"
			},
			sensitive: {
				"sensitive_title": "Entrada segura en la caja fuerte local",
				"sensitive_instruction_label": "Configurando credencial para {label}. ",
				"sensitive_note": "El valor se transmite solo a la caja fuerte local del proxy y nunca se guarda en el historial, la pantalla ni la exportación.",
				"sensitive_secret_label": "Clave de acceso / Secreto",
				"sensitive_secret_placeholder": "Pegue aquí la clave de acceso…",
				"sensitive_saving": "Guardando…",
				"sensitive_retry": "Reintentar",
				"sensitive_save": "Guardar en la caja fuerte",
				"sensitive_cancel": "Cancelar",
				"sensitive_aria": "Entrada segura de credencial",
				"sensitive_connection_fallback": "Conexión {provider}",
				"sensitive_error_default": "El proxy rechazó la credencial. Consulte el código abajo y vuelva a intentarlo.",
				"err_sensitive_target_missing": "No se indicó conexión ni proveedor. Abra la configuración de la conexión y elija el destino de la credencial.",
				"err_sensitive_revision_missing": "No se informó la revisión de la conexión. Reabra la conexión para usar el estado actual.",
				"err_sensitive_connection_id_invalid": "El identificador de la conexión no es válido. Reabra la conexión desde la lista.",
				"err_sensitive_provider_id_invalid": "El proveedor indicado no es válido. Elija el proveedor de la lista.",
				"err_sensitive_revision_conflict": "La conexión cambió desde que se abrió. Reábrala para usar la revisión actual.",
				"err_sensitive_connection_not_found": "La conexión ya no existe. Actualice la lista de conexiones.",
				"err_sensitive_unauthorized": "La sesión local expiró o fue revocada. Vuelva a conectarse al proxy local e intente de nuevo.",
				"err_sensitive_rate_limited": "Demasiados cambios en poco tiempo. Espere un momento e intente de nuevo.",
				"err_sensitive_limit_exceeded": "Se alcanzó el límite de conexiones. Elimine una conexión antes de crear otra.",
				"err_sensitive_multiconta_disabled": "Varias cuentas del mismo proveedor están desactivadas. Use la conexión existente.",
				"err_sensitive_invalid_profile": "El proxy rechazó los datos de la conexión. Revise el proveedor y la clave informada.",
				"err_sensitive_invalid_request": "El proxy rechazó la solicitud. Revise la clave informada.",
				"err_sensitive_confirmation_invalid": "El proxy no confirmó la escritura de esta conexión. Nada se marcó como guardado; actualice la lista antes de reintentar.",
				"err_sensitive_interrupted": "La conexión con el proxy cayó antes de la confirmación. Reintentar reutiliza la misma operación, sin duplicar."
			}
		},
		fr: {
			common: {
				ok: "OK",
				cancel: "Annuler",
				save: "Enregistrer",
				back: "Retour",
				confirm: "Confirmer",
				undo: "Annuler l'action"
			},
			shell: {
				proxy_connected: "Proxy Local Connecté",
				proxy_degraded: "Proxy Local Hors Ligne",
				select_model: "Sélectionner le Modèle Virtuel",
				new_chat: "Nouvelle Conversation"
			},
			composer: {
				placeholder: "Saisissez une instruction ou un message...",
				recording_audio: "Écoute en cours... Parlez maintenant",
				transcribing: "Traitement de la transcription locale...",
				attach_file: "Joindre un Fichier",
				link_folder: "Lier un Dossier Projet"
			},
			chat: {
				streaming_tokens: "Génération de la réponse...",
				stop_generation: "Arrêter la Génération",
				view_details: "Afficher Détails Techniques",
				hide_details: "Masquer Détails"
			},
			w5: {
				consent_title: "Demande de Modification de Fichier (Gouvernance W5)",
				approve_change: "Approuver la Modification",
				reject_change: "Rejeter la Modification",
				diff_additions: "{count, plural, one {# ajout} other {# ajouts}}",
				diff_deletions: "{count, plural, one {# suppression} other {# suppressions}}"
			},
			modals: {
				quota_panel_title: "Consommation et Plafond Budgétaire",
				endpoint_panel_title: "Coffre de Clés API (BYOK)",
				capability_title: "Catalogue d'Outils et Serveurs MCP"
			},
			errors: {
				network_unavailable: "Service temporairement indisponible. Vérifiez votre connexion locale.",
				quota_exceeded: "Plafond budgétaire atteint pour la période en cours.",
				key_expired: "La clé API configurée dans le coffre du système a expiré ou est invalide.",
				api_failed: "Échec de l'appel au service externe. Cliquez sur 'Détails' pour les actions recommandées."
			},
			privacy: {
				"privacy_title": "Confidentialité et données",
				"privacy_hint": "Préférences et exportations du service local. La rétention par le fournisseur d'IA est définie par le fournisseur.",
				"privacy_include_exports": "Inclure les messages dans les exportations",
				"privacy_notifications": "Notifications du navigateur",
				"privacy_quiet_hours": "Heures silencieuses",
				"privacy_quiet_start": "Début",
				"privacy_quiet_end": "Fin",
				"privacy_quiet_zone": "Fuseau horaire",
				"privacy_save_quiet": "Enregistrer les heures",
				"privacy_clear_quiet": "Effacer les heures",
				"privacy_export_prefs": "Exporter les préférences",
				"privacy_export_conversation": "Exporter la conversation actuelle",
				"privacy_export_receipts": "Exporter les reçus locaux",
				"privacy_files_title": "Fichiers générés et reçus locaux",
				"privacy_files_note": "Les références et les exécutions actives empêchent la suppression. L'identité des exécutions est conservée pour éviter la répétition d'opérations. Les copies exportées et les registres externes ont leur propre rétention.",
				"privacy_resource": "Ressource",
				"privacy_select": "Sélectionner",
				"privacy_confirm_resource": "Je confirme la suppression de la ressource sélectionnée",
				"privacy_delete_resource": "Supprimer la ressource",
				"privacy_conversation_title": "Supprimer la conversation actuelle du stockage local",
				"privacy_conversation_note": "La suppression efface cette conversation du service local. Elle ne supprime pas les copies ni les registres détenus par des fournisseurs externes.",
				"privacy_confirm_conversation": "Je confirme la suppression de cette conversation",
				"privacy_delete_conversation": "Supprimer la conversation",
				"privacy_download": "Télécharger le résultat",
				"privacy_delete_export": "Supprimer cette exportation du service",
				"privacy_refresh_result": "Consulter le résultat",
				"privacy_refresh": "Actualiser",
				"privacy_loading": "Chargement…",
				"privacy_blocked_prefix": "Suppression impossible pour le moment : ",
				"err_privacy_unavailable": "Impossible de charger les réglages de confidentialité. Réessayez.",
				"err_privacy_invalid": "Le service local a renvoyé des données inattendues. Rechargez la page et réessayez.",
				"err_privacy_export": "Exportation impossible pour le moment. Vérifiez l'état du service et réessayez.",
				"err_privacy_job": "Cette opération n'est plus disponible. Relancez-la.",
				"err_privacy_retention": "Cet élément ne peut pas être supprimé tant que des références ou des exécutions actives existent.",
				"privacy_job_kind_export": "Exportation",
				"privacy_job_state_completed": "terminée",
				"privacy_job_state_processing": "en cours",
				"privacy_job_state_failed": "échouée",
				"privacy_class_artifact": "Fichier généré",
				"privacy_class_receipts": "Reçus locaux",
				"privacy_blocked_unknown": "Suppression impossible pour le moment. La raison technique est repliée ci-dessous.",
				"privacy_job_kind_purge": "Suppression",
				"privacy_job_state_cancelled": "annulée",
				"privacy_class_export": "Exportation stockée",
				"privacy_unknown_value": "Valeur inconnue (détail replié)"
			},
			media: {
				"media_connect_service": "Connectez un service compatible pour continuer.",
				"media_connect_button": "Connecter un service",
				"media_prepare_error": "Impossible de préparer l'opération. Aucune exécution n'a été autorisée.",
				"media_activate_error": "Impossible d'activer le service. Vérifiez le modèle, le point de terminaison et la connexion.",
				"media_model": "Modèle",
				"media_endpoint": "Endpoint",
				"media_reference_url": "URL HTTPS publique provenant d’une origine autorisée dans le proxy. Le fournisseur récupérera cette image après votre consentement.",
				"media_local_reference_title": "Fichier local comme référence",
				"media_local_reference_note": "Le pilote utilise une URL HTTPS publique. Il ne publie pas de fichiers locaux. Pour utiliser une image initiale, configurez la prise en charge de frame_images et l'origine publique autorisée dans le profil vidéo.",
				"media_hint_image": "Cette identité sera utilisée pour la génération d'images. Choisissez un fournisseur qui la propose ; la génération reste soumise à votre autorisation.",
				"media_hint_video": "Cette identité sera utilisée pour la génération de vidéos. Choisissez un fournisseur qui la propose ; la génération reste soumise à votre autorisation.",
				"media_hint_speech": "Cette identité sera utilisée pour la synthèse vocale. Choisissez un fournisseur qui la propose ; la génération reste soumise à votre autorisation.",
				"media_hint_transcription": "Cette identité sera utilisée pour la transcription audio. Choisissez un fournisseur qui la propose ; la génération reste soumise à votre autorisation.",
				"media_load_error": "Impossible de charger le service ou de récupérer l'opération. Réessayez.",
				"media_processing_denied": "Activez le traitement par le fournisseur dans cette conversation pour utiliser ce service.",
				"media_result_recover_error": "Impossible de récupérer ce résultat.",
				"media_try_again": "Réessayer",
				"media_loading_result": "Chargement du résultat…",
				"media_output_invalid": "Le fichier reçu a échoué à la vérification média. La destination a été préservée ; réessayez de générer le résultat.",
				"media_output_timeout": "La vérification média a dépassé le temps disponible. La destination a été préservée ; réessayez d'enregistrer.",
				"media_save_error": "Impossible d'enregistrer le fichier. Le résultat reste disponible au téléchargement.",
				"media_loading": "Chargement…",
				"media_result_mismatch": "Le résultat ne correspond pas aux reçus de cette opération. Actualisez l'état avant d'utiliser le fichier.",
				"media_refresh": "Actualiser le service",
				"media_cancelled": "Opération annulée",
				"media_cancel": "Annuler l'opération",
				"media_local_only": "Le traitement de cette conversation est limité à cet appareil. Les services externes exigent de modifier cette option dans le chat.",
				"media_reference_image": "Image de référence",
				"media_initial_image_url": "URL de l'image initiale",
				"media_text_only_note": "Le service connecté propose la génération par texte. Les références exigent un point de terminaison d'édition compatible.",
				"media_kept_for_recovery": "Opération conservée pour récupération. Actualisez votre état avant d'en préparer une autre.",
				"media_reconnect": "L'opération doit être reconnectée. Ne renvoyez pas la demande.",
				"media_file_saved": "Fichier enregistré",
				"media_saving": "Enregistrement…",
				"media_save_file": "Enregistrer dans {name}",
				"media_kind_image": "Image",
				"media_kind_video": "Vidéo",
				"media_kind_speech": "Voix",
				"media_kind_transcription": "Transcription",
				"media_project_edit": "Modifier l'image",
				"media_transcript_note": "La continuité utilise cette transcription lorsqu'elle est sélectionnée dans le contexte. L'audio d'origine reste enregistré ; ses octets ne sont pas renvoyés dans ce cas.",
				"media_transcript_meta": "Transcription liée à l'audio d'origine · continuité par texte lorsqu'elle est sélectionnée dans le contexte",
				"media_result_preserved": "Le résultat est conservé. Actualisez l'opération pour terminer le lien avec la conversation, sans réexécuter.",
				"media_output_format_mismatch": "Le format reçu diffère de la destination choisie. Téléchargez le résultat dans son format d'origine.",
				"media_output_decoder_unavailable": "Ce navigateur ne peut pas vérifier le format reçu. La destination a été préservée ; vous pouvez télécharger l'original.",
				"media_run_status_unknown": "état non confirmé",
				"media_run_status_succeeded": "terminé",
				"media_run_status_failed": "échoué",
				"media_run_status_running": "en cours",
				"media_run_status_cancelled": "annulé",
				"media_run_status_awaiting": "en attente d'autorisation",
				"media_run_status_needs_attention": "demande de l'attention",
				"media_known_provider": "Fournisseur connu",
				"media_select_provider": "Choisir un fournisseur",
				"media_manage_accounts": "Gérer les comptes",
				"media_account_configured": "compte configuré",
				"media_no_image_provider": "Aucun fournisseur connu ne déclare encore la génération d'images. Gérez les comptes ou utilisez un endpoint manuel compatible.",
				"media_destination": "Destination : {name}",
				"media_remove": "Retirer"
			},
			sensitive: {
				"sensitive_title": "Saisie sécurisée dans le coffre local",
				"sensitive_instruction_label": "Configuration de la clé pour {label}. ",
				"sensitive_note": "La valeur n'est transmise qu'au coffre local du proxy et n'est jamais écrite dans l'historique, l'écran ou l'exportation.",
				"sensitive_secret_label": "Clé d'accès / Secret",
				"sensitive_secret_placeholder": "Collez ici la clé d'accès…",
				"sensitive_saving": "Enregistrement…",
				"sensitive_retry": "Réessayer",
				"sensitive_save": "Enregistrer dans le coffre",
				"sensitive_cancel": "Annuler",
				"sensitive_aria": "Saisie sécurisée d'identifiants",
				"sensitive_connection_fallback": "Connexion {provider}",
				"sensitive_error_default": "Le proxy a refusé l'identifiant. Consultez le code ci-dessous et réessayez.",
				"err_sensitive_target_missing": "Aucune connexion ni fournisseur n'a été indiqué. Ouvrez les paramètres de connexion et choisissez la destination de la clé.",
				"err_sensitive_revision_missing": "La révision de la connexion n'a pas été fournie. Rouvrez la connexion pour utiliser l'état actuel.",
				"err_sensitive_connection_id_invalid": "L'identifiant de la connexion est invalide. Rouvrez la connexion depuis la liste.",
				"err_sensitive_provider_id_invalid": "Le fournisseur indiqué est invalide. Choisissez le fournisseur dans la liste.",
				"err_sensitive_revision_conflict": "La connexion a changé depuis son ouverture. Rouvrez-la pour utiliser la révision actuelle.",
				"err_sensitive_connection_not_found": "La connexion n'existe plus. Actualisez la liste des connexions.",
				"err_sensitive_unauthorized": "La session locale a expiré ou a été révoquée. Reconnectez-vous au proxy local et réessayez.",
				"err_sensitive_rate_limited": "Trop de changements en peu de temps. Attendez un instant et réessayez.",
				"err_sensitive_limit_exceeded": "La limite de connexions est atteinte. Supprimez une connexion avant d’en créer une autre.",
				"err_sensitive_multiconta_disabled": "Plusieurs comptes pour le même fournisseur sont désactivés. Utilisez la connexion existante.",
				"err_sensitive_invalid_profile": "Le proxy a refusé les données de connexion. Vérifiez le fournisseur et la clé fournie.",
				"err_sensitive_invalid_request": "Le proxy a refusé la demande. Vérifiez la clé fournie.",
				"err_sensitive_confirmation_invalid": "Le proxy n'a pas confirmé l'écriture de cette connexion. Rien n'a été marqué comme enregistré ; actualisez la liste avant de réessayer.",
				"err_sensitive_interrupted": "La connexion au proxy a été interrompue avant la confirmation. Réessayer réutilise la même opération, sans dupliquer."
			}
		},
		de: {
			common: {
				ok: "OK",
				cancel: "Abbrechen",
				save: "Speichern",
				back: "Zurück",
				confirm: "Bestätigen",
				undo: "Rückgängig machen"
			},
			shell: {
				proxy_connected: "Lokaler Proxy Verbunden",
				proxy_degraded: "Lokaler Proxy Offline",
				select_model: "Virtuelles Modell Auswählen",
				new_chat: "Neues Gespräch"
			},
			composer: {
				placeholder: "Geben Sie eine Anweisung oder Nachricht ein...",
				recording_audio: "Zuhören... Jetzt sprechen",
				transcribing: "Lokale Transkription wird verarbeitet...",
				attach_file: "Datei Anhängen",
				link_folder: "Projektordner Verknüpfen"
			},
			chat: {
				streaming_tokens: "Antwort wird generiert...",
				stop_generation: "Generierung Stoppen",
				view_details: "Technische Details Anzeigen",
				hide_details: "Details Ausblenden"
			},
			w5: {
				consent_title: "Dateiänderungsanfrage (W5-Governance)",
				approve_change: "Änderung Genehmigen",
				reject_change: "Änderung Ablehnen",
				diff_additions: "{count, plural, one {# Hinzufügung} other {# Hinzufügungen}}",
				diff_deletions: "{count, plural, one {# Löschung} other {# Löschungen}}"
			},
			modals: {
				quota_panel_title: "Nutzung & Budgetobergrenze",
				endpoint_panel_title: "API-Schlüssel-Tresor (BYOK)",
				capability_title: "Werkzeug- & MCP-Server-Katalog"
			},
			errors: {
				network_unavailable: "Dienst vorübergehend nicht verfügbar. Überprüfen Sie Ihre lokale Verbindung.",
				quota_exceeded: "Budgetobergrenze für den aktuellen Zeitraum erreicht.",
				key_expired: "Der im Betriebssystem-Tresor konfigurierte API-Schlüssel ist abgelaufen oder ungültig.",
				api_failed: "Aufruf des externen Dienstes fehlgeschlagen. Klicken Sie auf 'Details' für empfohlene Aktionen."
			},
			privacy: {
				"privacy_title": "Datenschutz und Daten",
				"privacy_hint": "Einstellungen und Exporte des lokalen Dienstes. Die Aufbewahrung durch den KI-Anbieter wird vom Anbieter festgelegt.",
				"privacy_include_exports": "Nachrichten in Exporte einschließen",
				"privacy_notifications": "Browser-Benachrichtigungen",
				"privacy_quiet_hours": "Ruhezeiten",
				"privacy_quiet_start": "Beginn",
				"privacy_quiet_end": "Ende",
				"privacy_quiet_zone": "Zeitzone",
				"privacy_save_quiet": "Ruhezeiten speichern",
				"privacy_clear_quiet": "Ruhezeiten entfernen",
				"privacy_export_prefs": "Einstellungen exportieren",
				"privacy_export_conversation": "Aktuelles Gespräch exportieren",
				"privacy_export_receipts": "Lokale Belege exportieren",
				"privacy_files_title": "Generierte Dateien und lokale Belege",
				"privacy_files_note": "Referenzen und aktive Ausführungen verhindern das Löschen. Die Identität der Ausführungen bleibt erhalten, um doppelte Vorgänge zu vermeiden. Exportierte Kopien und externe Aufzeichnungen haben ihre eigene Aufbewahrung.",
				"privacy_resource": "Ressource",
				"privacy_select": "Auswählen",
				"privacy_confirm_resource": "Ich bestätige das Löschen der ausgewählten Ressource",
				"privacy_delete_resource": "Ressource löschen",
				"privacy_conversation_title": "Aktuelles Gespräch aus dem lokalen Speicher löschen",
				"privacy_conversation_note": "Das Löschen entfernt dieses Gespräch aus dem lokalen Dienst. Kopien oder Aufzeichnungen externer Anbieter werden nicht gelöscht.",
				"privacy_confirm_conversation": "Ich bestätige das Löschen dieses Gesprächs",
				"privacy_delete_conversation": "Gespräch löschen",
				"privacy_download": "Ergebnis herunterladen",
				"privacy_delete_export": "Diesen gespeicherten Export löschen",
				"privacy_refresh_result": "Ergebnis abrufen",
				"privacy_refresh": "Aktualisieren",
				"privacy_loading": "Wird geladen…",
				"privacy_blocked_prefix": "Löschen derzeit nicht möglich: ",
				"err_privacy_unavailable": "Datenschutzeinstellungen konnten nicht geladen werden. Versuchen Sie es erneut.",
				"err_privacy_invalid": "Der lokale Dienst hat unerwartete Daten zurückgegeben. Laden Sie die Seite neu und versuchen Sie es erneut.",
				"err_privacy_export": "Export derzeit nicht möglich. Prüfen Sie den Dienststatus und versuchen Sie es erneut.",
				"err_privacy_job": "Dieser Vorgang ist nicht mehr verfügbar. Starten Sie ihn erneut.",
				"err_privacy_retention": "Dieses Element kann nicht gelöscht werden, solange Referenzen oder aktive Ausführungen bestehen.",
				"privacy_job_kind_export": "Export",
				"privacy_job_state_completed": "abgeschlossen",
				"privacy_job_state_processing": "läuft",
				"privacy_job_state_failed": "fehlgeschlagen",
				"privacy_class_artifact": "Generierte Datei",
				"privacy_class_receipts": "Lokale Belege",
				"privacy_blocked_unknown": "Löschen derzeit nicht möglich. Der technische Grund ist unten eingeklappt.",
				"privacy_job_kind_purge": "Löschung",
				"privacy_job_state_cancelled": "abgebrochen",
				"privacy_class_export": "Gespeicherter Export",
				"privacy_unknown_value": "Unbekannter Wert (Detail eingeklappt)"
			},
			media: {
				"media_connect_service": "Verbinden Sie einen kompatiblen Dienst, um fortzufahren.",
				"media_connect_button": "Dienst verbinden",
				"media_prepare_error": "Vorgang konnte nicht vorbereitet werden. Es wurde nichts ausgeführt.",
				"media_activate_error": "Dienst konnte nicht aktiviert werden. Prüfen Sie Modell, Endpoint und Verbindung.",
				"media_model": "Modell",
				"media_endpoint": "Endpoint",
				"media_reference_url": "Öffentliche HTTPS-URL von einer im Proxy autorisierten Herkunft. Der Anbieter ruft dieses Bild nach Ihrer Zustimmung ab.",
				"media_local_reference_title": "Lokale Datei als Referenz",
				"media_local_reference_note": "Der Treiber verwendet eine öffentliche HTTPS-URL. Er veröffentlicht keine lokalen Dateien. Konfigurieren Sie für ein Ausgangsbild frame_images und die erlaubte öffentliche Herkunft im Videoprofil.",
				"media_hint_image": "Diese Anmeldung wird für die Bilderzeugung verwendet. Wählen Sie einen Anbieter, der sie anbietet; die Erzeugung erfordert weiterhin Ihre Freigabe.",
				"media_hint_video": "Diese Anmeldung wird für die Videoerzeugung verwendet. Wählen Sie einen Anbieter, der sie anbietet; die Erzeugung erfordert weiterhin Ihre Freigabe.",
				"media_hint_speech": "Diese Anmeldung wird für die Sprachausgabe verwendet. Wählen Sie einen Anbieter, der sie anbietet; die Erzeugung erfordert weiterhin Ihre Freigabe.",
				"media_hint_transcription": "Diese Anmeldung wird für die Audiotranskription verwendet. Wählen Sie einen Anbieter, der sie anbietet; die Erzeugung erfordert weiterhin Ihre Freigabe.",
				"media_load_error": "Dienst konnte nicht geladen oder Vorgang nicht wiederhergestellt werden. Versuchen Sie es erneut.",
				"media_processing_denied": "Aktivieren Sie die Anbieterverarbeitung in diesem Gespräch, um diesen Dienst zu nutzen.",
				"media_result_recover_error": "Dieses Ergebnis konnte nicht wiederhergestellt werden.",
				"media_try_again": "Erneut versuchen",
				"media_loading_result": "Ergebnis wird geladen…",
				"media_output_invalid": "Die empfangene Datei bestand die Medienprüfung nicht. Das Ziel blieb erhalten; versuchen Sie, das Ergebnis erneut zu erzeugen.",
				"media_output_timeout": "Die Medienprüfung überschritt die verfügbare Zeit. Das Ziel blieb erhalten; versuchen Sie erneut zu speichern.",
				"media_save_error": "Datei konnte nicht gespeichert werden. Das Ergebnis bleibt zum Download verfügbar.",
				"media_loading": "Wird geladen…",
				"media_result_mismatch": "Das Ergebnis stimmt nicht mit den Belegen dieses Vorgangs überein. Aktualisieren Sie den Status, bevor Sie die Datei verwenden.",
				"media_refresh": "Dienst aktualisieren",
				"media_cancelled": "Vorgang abgebrochen",
				"media_cancel": "Vorgang abbrechen",
				"media_local_only": "Die Verarbeitung dieses Gesprächs ist auf dieses Gerät beschränkt. Externe Dienste erfordern eine Änderung dieser Option im Chat.",
				"media_reference_image": "Referenzbild",
				"media_initial_image_url": "URL des Ausgangsbildes",
				"media_text_only_note": "Der verbundene Dienst bietet Textgenerierung. Referenzen erfordern einen kompatiblen Bearbeitungs-Endpoint.",
				"media_kept_for_recovery": "Vorgang zur Wiederherstellung behalten. Aktualisieren Sie Ihren Status, bevor Sie einen weiteren vorbereiten.",
				"media_reconnect": "Der Vorgang muss neu verbunden werden. Senden Sie die Anfrage nicht erneut.",
				"media_file_saved": "Datei gespeichert",
				"media_saving": "Wird gespeichert…",
				"media_save_file": "Speichern unter {name}",
				"media_kind_image": "Bild",
				"media_kind_video": "Video",
				"media_kind_speech": "Sprache",
				"media_kind_transcription": "Transkription",
				"media_project_edit": "Bild bearbeiten",
				"media_transcript_note": "Die Kontinuität verwendet diese Transkription, wenn sie im Kontext ausgewählt ist. Das Originalaudio bleibt gespeichert; seine Bytes werden in diesem Fall nicht erneut gesendet.",
				"media_transcript_meta": "Mit dem Originalaudio verknüpfte Transkription · Textfortsetzung bei Auswahl im Kontext",
				"media_result_preserved": "Das Ergebnis bleibt erhalten. Aktualisieren Sie den Vorgang, um die Verbindung zum Gespräch abzuschließen, ohne erneut auszuführen.",
				"media_output_format_mismatch": "Das empfangene Format weicht vom gewählten Ziel ab. Laden Sie das Ergebnis im Originalformat herunter.",
				"media_output_decoder_unavailable": "Dieser Browser kann das empfangene Format nicht prüfen. Das Ziel blieb erhalten; Sie können das Original herunterladen.",
				"media_run_status_unknown": "Status nicht bestätigt",
				"media_run_status_succeeded": "abgeschlossen",
				"media_run_status_failed": "fehlgeschlagen",
				"media_run_status_running": "läuft",
				"media_run_status_cancelled": "abgebrochen",
				"media_run_status_awaiting": "wartet auf Freigabe",
				"media_run_status_needs_attention": "braucht Aufmerksamkeit",
				"media_known_provider": "Bekannter Anbieter",
				"media_select_provider": "Anbieter wählen",
				"media_manage_accounts": "Konten verwalten",
				"media_account_configured": "Konto konfiguriert",
				"media_no_image_provider": "Kein bekannter Anbieter deklariert bisher Bilderzeugung. Verwalten Sie Konten oder nutzen Sie einen kompatiblen manuellen Endpoint.",
				"media_destination": "Ziel: {name}",
				"media_remove": "Entfernen"
			},
			sensitive: {
				"sensitive_title": "Sichere Eingabe in den lokalen Tresor",
				"sensitive_instruction_label": "Anmeldedaten für {label} werden eingerichtet. ",
				"sensitive_note": "Der Wert wird nur an den lokalen Tresor des Proxys übertragen und nie im Verlauf, auf dem Bildschirm oder im Export gespeichert.",
				"sensitive_secret_label": "Zugriffsschlüssel / Geheimnis",
				"sensitive_secret_placeholder": "Zugriffsschlüssel hier einfügen…",
				"sensitive_saving": "Wird gespeichert…",
				"sensitive_retry": "Erneut versuchen",
				"sensitive_save": "Im Tresor speichern",
				"sensitive_cancel": "Abbrechen",
				"sensitive_aria": "Sichere Anmeldedateneingabe",
				"sensitive_connection_fallback": "Verbindung {provider}",
				"sensitive_error_default": "Der Proxy hat die Anmeldedaten abgelehnt. Siehe Code unten und versuchen Sie es erneut.",
				"err_sensitive_target_missing": "Es wurde keine Verbindung und kein Anbieter angegeben. Öffnen Sie die Verbindungseinstellungen und wählen Sie das Ziel.",
				"err_sensitive_revision_missing": "Die Verbindungsrevision fehlt. Öffnen Sie die Verbindung erneut, um den aktuellen Stand zu verwenden.",
				"err_sensitive_connection_id_invalid": "Die Verbindungskennung ist ungültig. Öffnen Sie die Verbindung erneut über die Liste.",
				"err_sensitive_provider_id_invalid": "Der angegebene Anbieter ist ungültig. Wählen Sie den Anbieter aus der Liste.",
				"err_sensitive_revision_conflict": "Die Verbindung hat sich seit dem Öffnen geändert. Öffnen Sie sie erneut für die aktuelle Revision.",
				"err_sensitive_connection_not_found": "Die Verbindung existiert nicht mehr. Aktualisieren Sie die Verbindungsliste.",
				"err_sensitive_unauthorized": "Die lokale Sitzung ist abgelaufen oder wurde widerrufen. Verbinden Sie sich erneut mit dem lokalen Proxy.",
				"err_sensitive_rate_limited": "Zu viele Änderungen in kurzer Zeit. Warten Sie einen Moment und versuchen Sie es erneut.",
				"err_sensitive_limit_exceeded": "Das Verbindungslimit ist erreicht. Entfernen Sie eine Verbindung, bevor Sie eine neue erstellen.",
				"err_sensitive_multiconta_disabled": "Mehrere Konten desselben Anbieters sind deaktiviert. Verwenden Sie die bestehende Verbindung.",
				"err_sensitive_invalid_profile": "Der Proxy hat die Verbindungsdaten abgelehnt. Prüfen Sie Anbieter und Schlüssel.",
				"err_sensitive_invalid_request": "Der Proxy hat die Anfrage abgelehnt. Prüfen Sie den Schlüssel.",
				"err_sensitive_confirmation_invalid": "Der Proxy hat das Schreiben dieser Verbindung nicht bestätigt. Nichts wurde als gespeichert markiert; aktualisieren Sie die Liste vor einem erneuten Versuch.",
				"err_sensitive_interrupted": "Die Proxy-Verbindung wurde vor der Bestätigung unterbrochen. Ein erneuter Versuch verwendet dieselbe Operation, ohne zu duplizieren."
			}
		},
		it: {
			common: {
				ok: "OK",
				cancel: "Annulla",
				save: "Salva",
				back: "Indietro",
				confirm: "Conferma",
				undo: "Annulla azione"
			},
			shell: {
				proxy_connected: "Proxy Locale Connesso",
				proxy_degraded: "Proxy Locale Disconnesso",
				select_model: "Seleziona Modello Virtuale",
				new_chat: "Nuova Conversazione"
			},
			composer: {
				placeholder: "Digita un'istruzione o un messaggio...",
				recording_audio: "Ascolto in corso... Parla ora",
				transcribing: "Elaborazione trascrizione locale...",
				attach_file: "Allega File",
				link_folder: "Collega Cartella Progetto"
			},
			chat: {
				streaming_tokens: "Generazione risposta...",
				stop_generation: "Interrompi Generazione",
				view_details: "Mostra Dettagli Tecnici",
				hide_details: "Nascondi Dettagli"
			},
			w5: {
				consent_title: "Richiesta di Modifica File (Governance W5)",
				approve_change: "Approva Modifica",
				reject_change: "Rifiuta Modifica",
				diff_additions: "{count, plural, one {# aggiunta} other {# aggiunte}}",
				diff_deletions: "{count, plural, one {# eliminazione} other {# eliminazioni}}"
			},
			modals: {
				quota_panel_title: "Consumo e Tetto di Budget",
				endpoint_panel_title: "Cassaforte Chiavi API (BYOK)",
				capability_title: "Catalogo Strumenti e Server MCP"
			},
			errors: {
				network_unavailable: "Servizio temporaneamente non disponibile. Verifica la tua connessione locale.",
				quota_exceeded: "Tetto di budget raggiunto per il periodo corrente.",
				key_expired: "La chiave API configurata nella cassaforte del S.O. è scaduta o non è valida.",
				api_failed: "Chiamata al servizio esterno fallita. Clicca su 'Dettagli' per le azioni consigliate."
			},
			privacy: {
				"privacy_title": "Privacy e dati",
				"privacy_hint": "Preferenze ed esportazioni del servizio locale. La conservazione da parte del provider AI è definita dal provider.",
				"privacy_include_exports": "Includi i messaggi nelle esportazioni",
				"privacy_notifications": "Notifiche del browser",
				"privacy_quiet_hours": "Orari silenziosi",
				"privacy_quiet_start": "Inizio",
				"privacy_quiet_end": "Fine",
				"privacy_quiet_zone": "Fuso orario",
				"privacy_save_quiet": "Salva orari",
				"privacy_clear_quiet": "Rimuovi orari",
				"privacy_export_prefs": "Esporta preferenze",
				"privacy_export_conversation": "Esporta conversazione attuale",
				"privacy_export_receipts": "Esporta ricevute locali",
				"privacy_files_title": "File generati e ricevute locali",
				"privacy_files_note": "Riferimenti ed esecuzioni attive impediscono l’eliminazione. L’identità delle esecuzioni resta per evitare operazioni duplicate. Le copie esportate e i registri esterni hanno una propria conservazione.",
				"privacy_resource": "Risorsa",
				"privacy_select": "Seleziona",
				"privacy_confirm_resource": "Confermo l’eliminazione della risorsa selezionata",
				"privacy_delete_resource": "Elimina risorsa",
				"privacy_conversation_title": "Elimina la conversazione attuale dall’archivio locale",
				"privacy_conversation_note": "L’eliminazione rimuove questa conversazione dal servizio locale. Non elimina copie o registri detenuti da provider esterni.",
				"privacy_confirm_conversation": "Confermo l’eliminazione di questa conversazione",
				"privacy_delete_conversation": "Elimina conversazione",
				"privacy_download": "Scarica risultato",
				"privacy_delete_export": "Elimina questa esportazione dal servizio",
				"privacy_refresh_result": "Consulta risultato",
				"privacy_refresh": "Aggiorna",
				"privacy_loading": "Caricamento…",
				"privacy_blocked_prefix": "Eliminazione non possibile ora: ",
				"err_privacy_unavailable": "Impossibile caricare le impostazioni sulla privacy. Riprova.",
				"err_privacy_invalid": "Il servizio locale ha restituito dati inattesi. Ricarica la pagina e riprova.",
				"err_privacy_export": "Esportazione non possibile ora. Controlla lo stato del servizio e riprova.",
				"err_privacy_job": "Questa operazione non è più disponibile. Avviala di nuovo.",
				"err_privacy_retention": "Questo elemento non può essere eliminato finché esistono riferimenti o esecuzioni attive.",
				"privacy_job_kind_export": "Esportazione",
				"privacy_job_state_completed": "completata",
				"privacy_job_state_processing": "in corso",
				"privacy_job_state_failed": "non riuscita",
				"privacy_class_artifact": "File generato",
				"privacy_class_receipts": "Ricevute locali",
				"privacy_blocked_unknown": "Eliminazione non possibile ora. Il motivo tecnico è raccolto qui sotto.",
				"privacy_job_kind_purge": "Eliminazione",
				"privacy_job_state_cancelled": "annullata",
				"privacy_class_export": "Esportazione archiviata",
				"privacy_unknown_value": "Valore sconosciuto (dettaglio raccolto)"
			},
			media: {
				"media_connect_service": "Collega un servizio compatibile per continuare.",
				"media_connect_button": "Collega servizio",
				"media_prepare_error": "Impossibile preparare l’operazione. Nessuna esecuzione è stata autorizzata.",
				"media_activate_error": "Impossibile attivare il servizio. Controlla modello, endpoint e connessione.",
				"media_model": "Modello",
				"media_endpoint": "Endpoint",
				"media_reference_url": "URL HTTPS pubblica di un’origine autorizzata nel proxy. Il provider recupererà quell’immagine dopo il tuo consenso.",
				"media_local_reference_title": "File locale come riferimento",
				"media_local_reference_note": "Il driver usa una URL HTTPS pubblica. Non pubblica file locali. Per usare un’immagine iniziale, configura il supporto frame_images e l’origine pubblica consentita nel profilo video.",
				"media_hint_image": "Questa credenziale sarà usata per generare immagini. Scegli un provider che la offra; la generazione richiede comunque la tua autorizzazione.",
				"media_hint_video": "Questa credenziale sarà usata per generare video. Scegli un provider che la offra; la generazione richiede comunque la tua autorizzazione.",
				"media_hint_speech": "Questa credenziale sarà usata per il testo in voce. Scegli un provider che la offra; la generazione richiede comunque la tua autorizzazione.",
				"media_hint_transcription": "Questa credenziale sarà usata per trascrivere audio. Scegli un provider che la offra; la generazione richiede comunque la tua autorizzazione.",
				"media_load_error": "Impossibile caricare il servizio o recuperare l’operazione. Riprova.",
				"media_processing_denied": "Attiva l’elaborazione del provider in questa conversazione per usare questo servizio.",
				"media_result_recover_error": "Impossibile recuperare questo risultato.",
				"media_try_again": "Riprova",
				"media_loading_result": "Caricamento risultato…",
				"media_output_invalid": "Il file ricevuto non ha superato la verifica dei media. La destinazione è stata preservata; prova a generare di nuovo il risultato.",
				"media_output_timeout": "La verifica dei media ha superato il tempo disponibile. La destinazione è stata preservata; prova a salvare di nuovo.",
				"media_save_error": "Impossibile salvare il file. Il risultato resta disponibile per il download.",
				"media_loading": "Caricamento…",
				"media_result_mismatch": "Il risultato non corrisponde alle ricevute di questa operazione. Aggiorna lo stato prima di usare il file.",
				"media_refresh": "Aggiorna servizio",
				"media_cancelled": "Operazione annullata",
				"media_cancel": "Annulla operazione",
				"media_local_only": "L’elaborazione di questa conversazione è limitata a questo dispositivo. I servizi esterni richiedono di cambiare quell’opzione nella chat.",
				"media_reference_image": "Immagine di riferimento",
				"media_initial_image_url": "URL dell’immagine iniziale",
				"media_text_only_note": "Il servizio connesso offre la generazione da testo. I riferimenti richiedono un endpoint di modifica compatibile.",
				"media_kept_for_recovery": "Operazione conservata per il recupero. Aggiorna il tuo stato prima di prepararne un’altra.",
				"media_reconnect": "L’operazione deve essere riconnessa. Non inviare di nuovo la richiesta.",
				"media_file_saved": "File salvato",
				"media_saving": "Salvataggio…",
				"media_save_file": "Salva in {name}",
				"media_kind_image": "Immagine",
				"media_kind_video": "Video",
				"media_kind_speech": "Voce",
				"media_kind_transcription": "Trascrizione",
				"media_project_edit": "Modifica immagine",
				"media_transcript_note": "La continuità usa questa trascrizione quando è selezionata nel contesto. L’audio originale resta salvato; i suoi byte non vengono reinviati in quel caso.",
				"media_transcript_meta": "Trascrizione collegata all’audio originale · continuità per testo quando selezionata nel contesto",
				"media_result_preserved": "Il risultato è conservato. Aggiorna l’operazione per completare il collegamento con la conversazione, senza eseguire di nuovo.",
				"media_output_format_mismatch": "Il formato ricevuto differisce dalla destinazione scelta. Scarica il risultato nel formato originale.",
				"media_output_decoder_unavailable": "Questo browser non può verificare il formato ricevuto. La destinazione è stata preservata; puoi scaricare l’originale.",
				"media_run_status_unknown": "stato non confermato",
				"media_run_status_succeeded": "completato",
				"media_run_status_failed": "non riuscito",
				"media_run_status_running": "in esecuzione",
				"media_run_status_cancelled": "annullato",
				"media_run_status_awaiting": "in attesa di autorizzazione",
				"media_run_status_needs_attention": "richiede attenzione",
				"media_known_provider": "Provider noto",
				"media_select_provider": "Scegli provider",
				"media_manage_accounts": "Gestisci account",
				"media_account_configured": "account configurato",
				"media_no_image_provider": "Nessun provider noto dichiara ancora la generazione di immagini. Gestisci gli account o usa un endpoint manuale compatibile.",
				"media_destination": "Destinazione: {name}",
				"media_remove": "Rimuovi"
			},
			sensitive: {
				"sensitive_title": "Inserimento sicuro nel caveau locale",
				"sensitive_instruction_label": "Configurazione della credenziale per {label}. ",
				"sensitive_note": "Il valore viene trasmesso solo al caveau locale del proxy e non viene mai scritto nella cronologia, nello schermo o nell’esportazione.",
				"sensitive_secret_label": "Chiave di accesso / Segreto",
				"sensitive_secret_placeholder": "Incolla qui la chiave di accesso…",
				"sensitive_saving": "Salvataggio…",
				"sensitive_retry": "Riprova",
				"sensitive_save": "Salva nel caveau",
				"sensitive_cancel": "Annulla",
				"sensitive_aria": "Inserimento sicuro della credenziale",
				"sensitive_connection_fallback": "Connessione {provider}",
				"sensitive_error_default": "Il proxy ha rifiutato la credenziale. Consulta il codice qui sotto e riprova.",
				"err_sensitive_target_missing": "Non è stata indicata alcuna connessione o provider. Apri le impostazioni della connessione e scegli la destinazione.",
				"err_sensitive_revision_missing": "La revisione della connessione non è stata fornita. Riapri la connessione per usare lo stato attuale.",
				"err_sensitive_connection_id_invalid": "L’identificatore della connessione non è valido. Riapri la connessione dall’elenco.",
				"err_sensitive_provider_id_invalid": "Il provider indicato non è valido. Scegli il provider dall’elenco.",
				"err_sensitive_revision_conflict": "La connessione è cambiata da quando è stata aperta. Riaprila per usare la revisione attuale.",
				"err_sensitive_connection_not_found": "La connessione non esiste più. Aggiorna l’elenco delle connessioni.",
				"err_sensitive_unauthorized": "La sessione locale è scaduta o è stata revocata. Riconnettiti al proxy locale e riprova.",
				"err_sensitive_rate_limited": "Troppe modifiche in poco tempo. Attendi un momento e riprova.",
				"err_sensitive_limit_exceeded": "Il limite di connessioni è stato raggiunto. Rimuovi una connessione prima di crearne un’altra.",
				"err_sensitive_multiconta_disabled": "Più account per lo stesso provider sono disattivati. Usa la connessione esistente.",
				"err_sensitive_invalid_profile": "Il proxy ha rifiutato i dati della connessione. Controlla il provider e la chiave indicata.",
				"err_sensitive_invalid_request": "Il proxy ha rifiutato la richiesta. Controlla la chiave indicata.",
				"err_sensitive_confirmation_invalid": "Il proxy non ha confermato la scrittura di questa connessione. Nulla è stato segnato come salvato; aggiorna l’elenco prima di riprovare.",
				"err_sensitive_interrupted": "La connessione al proxy è caduta prima della conferma. Riprovare riutilizza la stessa operazione, senza duplicare."
			}
		},
		ja: {
			common: {
				ok: "OK",
				cancel: "キャンセル",
				save: "保存",
				back: "戻る",
				confirm: "確認",
				undo: "元に戻す"
			},
			shell: {
				proxy_connected: "ローカルプロキシ接続中",
				proxy_degraded: "ローカルプロキシがオフラインです",
				select_model: "仮想モデルを選択",
				new_chat: "新しい会話"
			},
			composer: {
				placeholder: "指示またはメッセージを入力...",
				recording_audio: "録音中... お話しください",
				transcribing: "ローカル文字起こしを処理中...",
				attach_file: "ファイルを添付",
				link_folder: "プロジェクトフォルダをリンク"
			},
			chat: {
				streaming_tokens: "応答を生成中...",
				stop_generation: "生成を停止",
				view_details: "技術的詳細を表示",
				hide_details: "詳細を非表示"
			},
			w5: {
				consent_title: "ファイル変更リクエスト (W5 ガバナンス)",
				approve_change: "変更を承認",
				reject_change: "変更を拒否",
				diff_additions: "{count} 件の追加",
				diff_deletions: "{count} 件の削除"
			},
			modals: {
				quota_panel_title: "使用量と予算上限",
				endpoint_panel_title: "APIキー保管庫 (BYOK)",
				capability_title: "ツール & MCPサーバーカタログ"
			},
			errors: {
				network_unavailable: "サービスは一時的に利用できません。ローカル接続を確認してください。",
				quota_exceeded: "現在の期間の予算上限に達しました。",
				key_expired: "OS保管庫に設定されたAPIキーの期限が切れているか、無効です。",
				api_failed: "外部サービス呼び出しに失敗しました。推奨される対応については「詳細」をクリックしてください。"
			},
			privacy: {
				"privacy_title": "プライバシーとデータ",
				"privacy_hint": "ローカルサービスの設定とエクスポート。AIプロバイダーによる保持はプロバイダーが定めます。",
				"privacy_include_exports": "エクスポートにメッセージを含める",
				"privacy_notifications": "ブラウザ通知",
				"privacy_quiet_hours": "おやすみ時間",
				"privacy_quiet_start": "開始",
				"privacy_quiet_end": "終了",
				"privacy_quiet_zone": "タイムゾーン",
				"privacy_save_quiet": "保存",
				"privacy_clear_quiet": "解除",
				"privacy_export_prefs": "設定をエクスポート",
				"privacy_export_conversation": "現在の会話をエクスポート",
				"privacy_export_receipts": "ローカル領収書をエクスポート",
				"privacy_files_title": "生成ファイルとローカル領収書",
				"privacy_files_note": "参照や実行中の処理があると削除できません。操作の重複を防ぐため実行の識別情報は保持されます。エクスポートしたコピーと外部記録にはそれぞれの保持期間があります。",
				"privacy_resource": "リソース",
				"privacy_select": "選択",
				"privacy_confirm_resource": "選択したリソースの削除を確認します",
				"privacy_delete_resource": "リソースを削除",
				"privacy_conversation_title": "現在の会話をローカルストレージから削除",
				"privacy_conversation_note": "削除するとローカルサービスからこの会話が消えます。外部プロバイダーが保持するコピーや記録は削除されません。",
				"privacy_confirm_conversation": "この会話の削除を確認します",
				"privacy_delete_conversation": "会話を削除",
				"privacy_download": "結果をダウンロード",
				"privacy_delete_export": "この保存済みエクスポートを削除",
				"privacy_refresh_result": "結果を確認",
				"privacy_refresh": "更新",
				"privacy_loading": "読み込み中…",
				"privacy_blocked_prefix": "現在削除できません: ",
				"err_privacy_unavailable": "プライバシー設定を読み込めませんでした。もう一度お試しください。",
				"err_privacy_invalid": "ローカルサービスが予期しないデータを返しました。ページを再読み込みしてもう一度お試しください。",
				"err_privacy_export": "現在エクスポートできません。サービスの状態を確認してもう一度お試しください。",
				"err_privacy_job": "この操作はもう利用できません。最初からやり直してください。",
				"err_privacy_retention": "参照や実行中の処理が存在する間はこの項目を削除できません。",
				"privacy_job_kind_export": "エクスポート",
				"privacy_job_state_completed": "完了",
				"privacy_job_state_processing": "処理中",
				"privacy_job_state_failed": "失敗",
				"privacy_class_artifact": "生成ファイル",
				"privacy_class_receipts": "ローカル領収書",
				"privacy_blocked_unknown": "現在削除できません。技術的な理由は下に折りたたまれています。",
				"privacy_job_kind_purge": "削除",
				"privacy_job_state_cancelled": "キャンセル済み",
				"privacy_class_export": "保存済みエクスポート",
				"privacy_unknown_value": "不明な値（詳細は折りたたみ）"
			},
			media: {
				"media_connect_service": "続行するには対応サービスを接続してください。",
				"media_connect_button": "サービスを接続",
				"media_prepare_error": "操作を準備できませんでした。何も実行されていません。",
				"media_activate_error": "サービスを有効にできませんでした。モデル、エンドポイント、接続を確認してください。",
				"media_model": "モデル",
				"media_endpoint": "エンドポイント",
				"media_reference_url": "プロキシで許可されたオリジンの公開HTTPS URL。同意後にプロバイダーがその画像を取得します。",
				"media_local_reference_title": "ローカルファイルを参照として使用",
				"media_local_reference_note": "ドライバーは公開HTTPS URLを使用します。ローカルファイルは公開しません。初期画像を使うには、ビデオプロファイルでframe_images対応と許可された公開オリジンを設定してください。",
				"media_hint_image": "この認証情報は画像生成に使用されます。対応するプロバイダーを選んでください。生成には引き続き承認が必要です。",
				"media_hint_video": "この認証情報は動画生成に使用されます。対応するプロバイダーを選んでください。生成には引き続き承認が必要です。",
				"media_hint_speech": "この認証情報は音声合成に使用されます。対応するプロバイダーを選んでください。生成には引き続き承認が必要です。",
				"media_hint_transcription": "この認証情報は音声文字起こしに使用されます。対応するプロバイダーを選んでください。生成には引き続き承認が必要です。",
				"media_load_error": "サービスを読み込めないか、操作を復元できませんでした。もう一度お試しください。",
				"media_processing_denied": "このサービスを使うには、この会話でプロバイダー処理を有効にしてください。",
				"media_result_recover_error": "この結果を復元できませんでした。",
				"media_try_again": "もう一度試す",
				"media_loading_result": "結果を読み込み中…",
				"media_output_invalid": "受信ファイルがメディア検証を通過しませんでした。出力先は保持されています。結果をもう一度生成してください。",
				"media_output_timeout": "メディア検証が制限時間を超えました。出力先は保持されています。もう一度保存してください。",
				"media_save_error": "ファイルを保存できませんでした。結果は引き続きダウンロードできます。",
				"media_loading": "読み込み中…",
				"media_result_mismatch": "結果がこの操作の領収書と一致しません。ファイルを使う前に状態を更新してください。",
				"media_refresh": "サービスを更新",
				"media_cancelled": "操作をキャンセルしました",
				"media_cancel": "操作をキャンセル",
				"media_local_only": "この会話の処理はこのデバイスに限定されています。外部サービスを利用するにはチャットでその設定を変更してください。",
				"media_reference_image": "参照画像",
				"media_initial_image_url": "初期画像のURL",
				"media_text_only_note": "接続中のサービスはテキスト生成のみ対応しています。参照画像には互換性のある編集エンドポイントの設定が必要です。",
				"media_kept_for_recovery": "操作は復元用に保持されています。次の操作を準備する前に状態を更新してください。",
				"media_reconnect": "操作の再接続が必要です。リクエストを再送しないでください。",
				"media_file_saved": "ファイルを保存しました",
				"media_saving": "保存中…",
				"media_save_file": "{name} に保存",
				"media_kind_image": "画像",
				"media_kind_video": "動画",
				"media_kind_speech": "音声",
				"media_kind_transcription": "文字起こし",
				"media_project_edit": "画像を編集",
				"media_transcript_note": "コンテキストで選択されている場合、継続処理はこの文字起こしを使用します。元の音声は保存されたままで、そのバイトは再送信されません。",
				"media_transcript_meta": "元の音声にリンクされた文字起こし · コンテキストで選択された場合はテキストで継続",
				"media_result_preserved": "結果は保持されています。会話とのリンクを完了するには操作を更新してください。再実行は不要です。",
				"media_output_format_mismatch": "受信した形式が選択した出力先と異なります。元の形式で結果をダウンロードしてください。",
				"media_output_decoder_unavailable": "このブラウザでは受信形式を検証できません。出力先は保持されています。元のファイルをダウンロードできます。",
				"media_run_status_unknown": "状態未確認",
				"media_run_status_succeeded": "完了",
				"media_run_status_failed": "失敗",
				"media_run_status_running": "実行中",
				"media_run_status_cancelled": "キャンセル済み",
				"media_run_status_awaiting": "承認待ち",
				"media_run_status_needs_attention": "要対応",
				"media_known_provider": "既知のプロバイダー",
				"media_select_provider": "プロバイダーを選択",
				"media_manage_accounts": "アカウントを管理",
				"media_account_configured": "アカウント設定済み",
				"media_no_image_provider": "画像生成を宣言している既知のプロバイダーはまだありません。アカウントを管理するか、互換性のある手動エンドポイントを使用してください。",
				"media_destination": "出力先: {name}",
				"media_remove": "削除"
			},
			sensitive: {
				"sensitive_title": "ローカル保管庫への安全な入力",
				"sensitive_instruction_label": "{label} の認証情報を設定しています。",
				"sensitive_note": "値はローカルプロキシの保管庫にのみ送信され、履歴・画面・エクスポートには一切保存されません。",
				"sensitive_secret_label": "アクセスキー / シークレット",
				"sensitive_secret_placeholder": "アクセスキーをここに貼り付け…",
				"sensitive_saving": "保存中…",
				"sensitive_retry": "再試行",
				"sensitive_save": "保管庫に保存",
				"sensitive_cancel": "キャンセル",
				"sensitive_aria": "認証情報の安全な入力",
				"sensitive_connection_fallback": "接続 {provider}",
				"sensitive_error_default": "プロキシが認証情報を拒否しました。下のコードを確認して再試行してください。",
				"err_sensitive_target_missing": "接続もプロバイダーも指定されていません。接続設定を開いて認証情報の送信先を選んでください。",
				"err_sensitive_revision_missing": "接続のリビジョンがありません。現在の状態を使うには接続を開き直してください。",
				"err_sensitive_connection_id_invalid": "接続IDが無効です。一覧から接続を開き直してください。",
				"err_sensitive_provider_id_invalid": "指定されたプロバイダーが無効です。一覧から選んでください。",
				"err_sensitive_revision_conflict": "接続は開いた後に変更されました。現在のリビジョンを使うには開き直してください。",
				"err_sensitive_connection_not_found": "接続はもう存在しません。接続一覧を更新してください。",
				"err_sensitive_unauthorized": "ローカルセッションの期限が切れたか取り消されました。ローカルプロキシに再接続して再試行してください。",
				"err_sensitive_rate_limited": "短時間に変更が多すぎます。しばらく待って再試行してください。",
				"err_sensitive_limit_exceeded": "接続数の上限に達しました。新しい接続を作る前に1つ削除してください。",
				"err_sensitive_multiconta_disabled": "同じプロバイダーの複数アカウントは無効です。既存の接続を使ってください。",
				"err_sensitive_invalid_profile": "プロキシが接続データを拒否しました。プロバイダーと入力したキーを確認してください。",
				"err_sensitive_invalid_request": "プロキシが要求を拒否しました。入力したキーを確認してください。",
				"err_sensitive_confirmation_invalid": "プロキシはこの接続の書き込みを確認しませんでした。保存済みとは扱われていません。再試行前に一覧を更新してください。",
				"err_sensitive_interrupted": "確認前にプロキシ接続が切れました。再試行は同じ操作を再利用し、重複しません。"
			}
		},
		ko: {
			common: {
				ok: "확인",
				cancel: "취소",
				save: "저장",
				back: "뒤로",
				confirm: "확인",
				undo: "실행 취소"
			},
			shell: {
				proxy_connected: "로컬 프록시 연결됨",
				proxy_degraded: "로컬 프록시 오프라인",
				select_model: "가상 모델 선택",
				new_chat: "새 대화"
			},
			composer: {
				placeholder: "지시 사항 또는 메시지를 입력하세요...",
				recording_audio: "음성 인식 중... 말씀하세요",
				transcribing: "로컬 받아쓰기 처리 중...",
				attach_file: "파일 첨부",
				link_folder: "프로젝트 폴더 연결"
			},
			chat: {
				streaming_tokens: "응답 생성 중...",
				stop_generation: "생성 중단",
				view_details: "기술 세부정보 보기",
				hide_details: "세부정보 숨기기"
			},
			w5: {
				consent_title: "파일 변경 요청 (W5 거버넌스)",
				approve_change: "변경 승인",
				reject_change: "변경 거부",
				diff_additions: "{count}개 추가",
				diff_deletions: "{count}개 삭제"
			},
			modals: {
				quota_panel_title: "사용량 및 예산 한도",
				endpoint_panel_title: "API 키 금고 (BYOK)",
				capability_title: "도구 및 MCP 서버 카탈로그"
			},
			errors: {
				network_unavailable: "서비스를 일시적으로 사용할 수 없습니다. 로컬 연결을 확인하세요.",
				quota_exceeded: "현재 기간의 예산 한도에 도달했습니다.",
				key_expired: "OS 금고에 설정된 API 키가 만료되었거나 유효하지 않습니다.",
				api_failed: "외부 서비스 호출에 실패했습니다. 권장 조치는 '세부정보'를 클릭하세요."
			},
			privacy: {
				"privacy_title": "개인정보 및 데이터",
				"privacy_hint": "로컬 서비스 설정 및 내보내기. AI 공급자의 보존 정책은 공급자가 정합니다.",
				"privacy_include_exports": "내보내기에 메시지 포함",
				"privacy_notifications": "브라우저 알림",
				"privacy_quiet_hours": "조용한 시간",
				"privacy_quiet_start": "시작",
				"privacy_quiet_end": "종료",
				"privacy_quiet_zone": "시간대",
				"privacy_save_quiet": "저장",
				"privacy_clear_quiet": "지우기",
				"privacy_export_prefs": "기본 설정 내보내기",
				"privacy_export_conversation": "현재 대화 내보내기",
				"privacy_export_receipts": "로컬 영수증 내보내기",
				"privacy_files_title": "생성 파일 및 로컬 영수증",
				"privacy_files_note": "참조와 실행 중인 작업이 있으면 삭제할 수 없습니다. 중복 작업을 막기 위해 실행 식별 정보는 유지됩니다. 내보낸 사본과 외부 기록은 각자의 보존 정책을 따릅니다.",
				"privacy_resource": "리소스",
				"privacy_select": "선택",
				"privacy_confirm_resource": "선택한 리소스 삭제를 확인합니다",
				"privacy_delete_resource": "리소스 삭제",
				"privacy_conversation_title": "현재 대화를 로컬 저장소에서 삭제",
				"privacy_conversation_note": "삭제하면 로컬 서비스에서 이 대화가 제거됩니다. 외부 공급자가 보관한 사본이나 기록은 삭제되지 않습니다.",
				"privacy_confirm_conversation": "이 대화의 삭제를 확인합니다",
				"privacy_delete_conversation": "대화 삭제",
				"privacy_download": "결과 다운로드",
				"privacy_delete_export": "이 저장된 내보내기 삭제",
				"privacy_refresh_result": "결과 확인",
				"privacy_refresh": "새로고침",
				"privacy_loading": "불러오는 중…",
				"privacy_blocked_prefix": "지금은 삭제할 수 없습니다: ",
				"err_privacy_unavailable": "개인정보 설정을 불러오지 못했습니다. 다시 시도하세요.",
				"err_privacy_invalid": "로컬 서비스가 예상치 못한 데이터를 반환했습니다. 페이지를 새로고침하고 다시 시도하세요.",
				"err_privacy_export": "지금은 내보낼 수 없습니다. 서비스 상태를 확인하고 다시 시도하세요.",
				"err_privacy_job": "이 작업은 더 이상 사용할 수 없습니다. 다시 시작하세요.",
				"err_privacy_retention": "참조나 실행 중인 작업이 있는 동안에는 이 항목을 삭제할 수 없습니다.",
				"privacy_job_kind_export": "내보내기",
				"privacy_job_state_completed": "완료",
				"privacy_job_state_processing": "처리 중",
				"privacy_job_state_failed": "실패",
				"privacy_class_artifact": "생성 파일",
				"privacy_class_receipts": "로컬 영수증",
				"privacy_blocked_unknown": "지금은 삭제할 수 없습니다. 기술적 이유는 아래에 접혀 있습니다.",
				"privacy_job_kind_purge": "삭제",
				"privacy_job_state_cancelled": "취소됨",
				"privacy_class_export": "저장된 내보내기",
				"privacy_unknown_value": "알 수 없는 값(세부정보 접힘)"
			},
			media: {
				"media_connect_service": "계속하려면 호환되는 서비스를 연결하세요.",
				"media_connect_button": "서비스 연결",
				"media_prepare_error": "작업을 준비하지 못했습니다. 아무것도 실행되지 않았습니다.",
				"media_activate_error": "서비스를 활성화하지 못했습니다. 모델, 엔드포인트, 연결을 확인하세요.",
				"media_model": "모델",
				"media_endpoint": "엔드포인트",
				"media_reference_url": "프록시에서 허용된 출처의 공개 HTTPS URL입니다. 동의 후 공급자가 해당 이미지를 가져옵니다.",
				"media_local_reference_title": "로컬 파일을 참조로 사용",
				"media_local_reference_note": "드라이버는 공개 HTTPS URL을 사용합니다. 로컬 파일을 게시하지 않습니다. 초기 이미지를 사용하려면 비디오 프로필에 frame_images 지원과 허용된 공개 출처를 설정하세요.",
				"media_hint_image": "이 자격 증명은 이미지 생성에 사용됩니다. 해당 기능을 제공하는 공급자를 선택하세요. 생성에는 계속 승인이 필요합니다.",
				"media_hint_video": "이 자격 증명은 동영상 생성에 사용됩니다. 해당 기능을 제공하는 공급자를 선택하세요. 생성에는 계속 승인이 필요합니다.",
				"media_hint_speech": "이 자격 증명은 음성 합성에 사용됩니다. 해당 기능을 제공하는 공급자를 선택하세요. 생성에는 계속 승인이 필요합니다.",
				"media_hint_transcription": "이 자격 증명은 오디오 받아쓰기에 사용됩니다. 해당 기능을 제공하는 공급자를 선택하세요. 생성에는 계속 승인이 필요합니다.",
				"media_load_error": "서비스를 불러오거나 작업을 복구하지 못했습니다. 다시 시도하세요.",
				"media_processing_denied": "이 서비스를 사용하려면 이 대화에서 공급자 처리를 활성화하세요.",
				"media_result_recover_error": "이 결과를 복구하지 못했습니다.",
				"media_try_again": "다시 시도",
				"media_loading_result": "결과 불러오는 중…",
				"media_output_invalid": "받은 파일이 미디어 검증을 통과하지 못했습니다. 대상은 보존되었으니 결과를 다시 생성해 보세요.",
				"media_output_timeout": "미디어 검증이 시간을 초과했습니다. 대상은 보존되었으니 다시 저장해 보세요.",
				"media_save_error": "파일을 저장하지 못했습니다. 결과는 계속 다운로드할 수 있습니다.",
				"media_loading": "불러오는 중…",
				"media_result_mismatch": "결과가 이 작업의 영수증과 일치하지 않습니다. 파일을 사용하기 전에 상태를 새로고침하세요.",
				"media_refresh": "서비스 새로고침",
				"media_cancelled": "작업 취소됨",
				"media_cancel": "작업 취소",
				"media_local_only": "이 대화의 처리는 이 기기로 제한됩니다. 외부 서비스를 사용하려면 채팅에서 해당 옵션을 변경하세요.",
				"media_reference_image": "참조 이미지",
				"media_initial_image_url": "초기 이미지 URL",
				"media_text_only_note": "연결된 서비스는 텍스트 생성을 제공합니다. 참조를 사용하려면 호환되는 편집 엔드포인트를 설정해야 합니다.",
				"media_kept_for_recovery": "복구를 위해 작업이 유지되었습니다. 다른 작업을 준비하기 전에 상태를 새로고침하세요.",
				"media_reconnect": "작업을 다시 연결해야 합니다. 요청을 다시 보내지 마세요.",
				"media_file_saved": "파일 저장됨",
				"media_saving": "저장 중…",
				"media_save_file": "{name}에 저장",
				"media_kind_image": "이미지",
				"media_kind_video": "동영상",
				"media_kind_speech": "음성",
				"media_kind_transcription": "받아쓰기",
				"media_project_edit": "이미지 편집",
				"media_transcript_note": "컨텍스트에서 선택된 경우 연속 처리는 이 받아쓰기를 사용합니다. 원본 오디오는 저장된 상태로 유지되며 해당 바이트는 다시 전송되지 않습니다.",
				"media_transcript_meta": "원본 오디오에 연결된 받아쓰기 · 컨텍스트에서 선택된 경우 텍스트로 계속",
				"media_result_preserved": "결과는 보존되었습니다. 다시 실행하지 않고 대화 연결을 완료하려면 작업을 새로고침하세요.",
				"media_output_format_mismatch": "받은 형식이 선택한 대상과 다릅니다. 원래 형식으로 결과를 다운로드하세요.",
				"media_output_decoder_unavailable": "이 브라우저는 받은 형식을 검증할 수 없습니다. 대상은 보존되었으며 원본을 다운로드할 수 있습니다.",
				"media_run_status_unknown": "상태 미확인",
				"media_run_status_succeeded": "완료",
				"media_run_status_failed": "실패",
				"media_run_status_running": "실행 중",
				"media_run_status_cancelled": "취소됨",
				"media_run_status_awaiting": "승인 대기",
				"media_run_status_needs_attention": "주의 필요",
				"media_known_provider": "알려진 공급자",
				"media_select_provider": "공급자 선택",
				"media_manage_accounts": "계정 관리",
				"media_account_configured": "계정 구성됨",
				"media_no_image_provider": "이미지 생성을 선언한 알려진 공급자가 아직 없습니다. 계정을 관리하거나 호환되는 수동 엔드포인트를 사용하세요.",
				"media_destination": "대상: {name}",
				"media_remove": "제거"
			},
			sensitive: {
				"sensitive_title": "로컬 저장소에 안전하게 입력",
				"sensitive_instruction_label": "{label} 자격 증명을 설정하는 중입니다.",
				"sensitive_note": "값은 로컬 프록시 저장소에만 전송되며 기록, 화면, 내보내기에 저장되지 않습니다.",
				"sensitive_secret_label": "액세스 키 / 비밀",
				"sensitive_secret_placeholder": "여기에 액세스 키를 붙여넣으세요…",
				"sensitive_saving": "저장 중…",
				"sensitive_retry": "다시 시도",
				"sensitive_save": "저장소에 저장",
				"sensitive_cancel": "취소",
				"sensitive_aria": "자격 증명 안전 입력",
				"sensitive_connection_fallback": "연결 {provider}",
				"sensitive_error_default": "프록시가 자격 증명을 거부했습니다. 아래 코드를 확인하고 다시 시도하세요.",
				"err_sensitive_target_missing": "연결이나 공급자가 지정되지 않았습니다. 연결 설정을 열고 자격 증명 대상을 선택하세요.",
				"err_sensitive_revision_missing": "연결 개정 정보가 없습니다. 현재 상태를 사용하려면 연결을 다시 여세요.",
				"err_sensitive_connection_id_invalid": "연결 ID가 올바르지 않습니다. 목록에서 연결을 다시 여세요.",
				"err_sensitive_provider_id_invalid": "지정된 공급자가 올바르지 않습니다. 목록에서 선택하세요.",
				"err_sensitive_revision_conflict": "연결이 열린 이후 변경되었습니다. 현재 개정을 사용하려면 다시 여세요.",
				"err_sensitive_connection_not_found": "연결이 더 이상 존재하지 않습니다. 연결 목록을 새로고침하세요.",
				"err_sensitive_unauthorized": "로컬 세션이 만료되었거나 취소되었습니다. 로컬 프록시에 다시 연결하고 재시도하세요.",
				"err_sensitive_rate_limited": "짧은 시간에 변경이 너무 많습니다. 잠시 후 다시 시도하세요.",
				"err_sensitive_limit_exceeded": "연결 한도에 도달했습니다. 새 연결을 만들기 전에 하나를 삭제하세요.",
				"err_sensitive_multiconta_disabled": "같은 공급자의 여러 계정은 비활성화되어 있습니다. 기존 연결을 사용하세요.",
				"err_sensitive_invalid_profile": "프록시가 연결 데이터를 거부했습니다. 공급자와 입력한 키를 확인하세요.",
				"err_sensitive_invalid_request": "프록시가 요청을 거부했습니다. 입력한 키를 확인하세요.",
				"err_sensitive_confirmation_invalid": "프록시가 이 연결 쓰기를 확인하지 않았습니다. 저장된 것으로 표시되지 않았으니 재시도 전에 목록을 새로고침하세요.",
				"err_sensitive_interrupted": "확인 전에 프록시 연결이 끊겼습니다. 재시도는 같은 작업을 재사용하며 중복되지 않습니다."
			}
		},
		"zh-CN": {
			common: {
				ok: "确定",
				cancel: "取消",
				save: "保存",
				back: "返回",
				confirm: "确认",
				undo: "撤销"
			},
			shell: {
				proxy_connected: "本地代理已连接",
				proxy_degraded: "本地代理已离线",
				select_model: "选择虚拟模型",
				new_chat: "新建对话"
			},
			composer: {
				placeholder: "输入指令或消息...",
				recording_audio: "正在聆听... 请讲话",
				transcribing: "正在处理本地语音转录...",
				attach_file: "附加文件",
				link_folder: "关联项目文件夹"
			},
			chat: {
				streaming_tokens: "正在生成回答...",
				stop_generation: "停止生成",
				view_details: "查看技术细节",
				hide_details: "隐藏细节"
			},
			w5: {
				consent_title: "文件修改请求 (W5 治理)",
				approve_change: "批准修改",
				reject_change: "拒绝修改",
				diff_additions: "{count} 项新增",
				diff_deletions: "{count} 项删除"
			},
			modals: {
				quota_panel_title: "用量与预算上限",
				endpoint_panel_title: "API 密钥保险库 (BYOK)",
				capability_title: "工具与 MCP 服务器目录"
			},
			errors: {
				network_unavailable: "服务暂时不可用。请检查本地网络连接。",
				quota_exceeded: "已达到当前计费周期的预算上限。",
				key_expired: "操作系统保险库中配置的 API 密钥已过期或无效。",
				api_failed: "外部服务调用失败。点击“细节”查看建议的操作。"
			},
			privacy: {
				"privacy_title": "隐私与数据",
				"privacy_hint": "本地服务偏好设置与导出。AI 提供方的数据保留由其自行决定。",
				"privacy_include_exports": "在导出中包含消息内容",
				"privacy_notifications": "浏览器通知",
				"privacy_quiet_hours": "免打扰时段",
				"privacy_quiet_start": "开始",
				"privacy_quiet_end": "结束",
				"privacy_quiet_zone": "时区",
				"privacy_save_quiet": "保存时段",
				"privacy_clear_quiet": "清除时段",
				"privacy_export_prefs": "导出偏好设置",
				"privacy_export_conversation": "导出当前对话",
				"privacy_export_receipts": "导出本地收据",
				"privacy_files_title": "已生成文件与本地收据",
				"privacy_files_note": "存在引用或正在执行的运行时会阻止删除。执行标识会保留以防重复操作。导出的副本和外部记录有其各自的保留策略。",
				"privacy_resource": "资源",
				"privacy_select": "选择",
				"privacy_confirm_resource": "我确认删除所选资源",
				"privacy_delete_resource": "删除资源",
				"privacy_conversation_title": "从本地存储中删除当前对话",
				"privacy_conversation_note": "删除会从本地服务中移除该对话，但不会删除外部提供方持有的副本或记录。",
				"privacy_confirm_conversation": "我确认删除此对话",
				"privacy_delete_conversation": "删除对话",
				"privacy_download": "下载结果",
				"privacy_delete_export": "删除此已存储的导出",
				"privacy_refresh_result": "查看结果",
				"privacy_refresh": "刷新",
				"privacy_loading": "正在加载…",
				"privacy_blocked_prefix": "当前无法删除：",
				"err_privacy_unavailable": "无法加载隐私设置。请重试。",
				"err_privacy_invalid": "本地服务返回了意外数据。请刷新页面后重试。",
				"err_privacy_export": "当前无法导出。请检查服务状态后重试。",
				"err_privacy_job": "此操作已不可用。请重新开始。",
				"err_privacy_retention": "存在引用或正在执行的运行时，无法删除此项目。",
				"privacy_job_kind_export": "导出",
				"privacy_job_state_completed": "已完成",
				"privacy_job_state_processing": "处理中",
				"privacy_job_state_failed": "失败",
				"privacy_class_artifact": "已生成文件",
				"privacy_class_receipts": "本地收据",
				"privacy_blocked_unknown": "当前无法删除。技术原因已折叠在下方。",
				"privacy_job_kind_purge": "删除",
				"privacy_job_state_cancelled": "已取消",
				"privacy_class_export": "已存储的导出",
				"privacy_unknown_value": "未知值（细节已折叠）"
			},
			media: {
				"media_connect_service": "请连接兼容的服务以继续。",
				"media_connect_button": "连接服务",
				"media_prepare_error": "无法准备操作。未执行任何内容。",
				"media_activate_error": "无法启用服务。请检查模型、端点和连接。",
				"media_model": "模型",
				"media_endpoint": "端点",
				"media_reference_url": "来自代理授权来源的公开 HTTPS URL。经您同意后，提供方将获取该图像。",
				"media_local_reference_title": "使用本地文件作为参考",
				"media_local_reference_note": "驱动程序使用公开 HTTPS URL，不会发布本地文件。要使用初始图像，请在视频配置中设置 frame_images 支持和允许的公开来源。",
				"media_hint_image": "此凭据将用于图像生成。请选择提供该功能的提供方；生成仍需您的授权。",
				"media_hint_video": "此凭据将用于视频生成。请选择提供该功能的提供方；生成仍需您的授权。",
				"media_hint_speech": "此凭据将用于语音合成。请选择提供该功能的提供方；生成仍需您的授权。",
				"media_hint_transcription": "此凭据将用于音频转录。请选择提供该功能的提供方；生成仍需您的授权。",
				"media_load_error": "无法加载服务或恢复操作。请重试。",
				"media_processing_denied": "请在此对话中启用提供方处理以使用此服务。",
				"media_result_recover_error": "无法恢复此结果。",
				"media_try_again": "重试",
				"media_loading_result": "正在加载结果…",
				"media_output_invalid": "收到的文件未通过媒体校验。目标已保留；请重新生成结果。",
				"media_output_timeout": "媒体校验超时。目标已保留；请重新保存。",
				"media_save_error": "无法保存文件。结果仍可下载。",
				"media_loading": "正在加载…",
				"media_result_mismatch": "结果与此操作的收据不符。请在使用文件前刷新状态。",
				"media_refresh": "刷新服务",
				"media_cancelled": "操作已取消",
				"media_cancel": "取消操作",
				"media_local_only": "此对话的处理仅限本设备。使用外部服务需在聊天中更改该选项。",
				"media_reference_image": "参考图像",
				"media_initial_image_url": "初始图像 URL",
				"media_text_only_note": "已连接的服务提供文字生成。使用参考图需要配置兼容的编辑端点。",
				"media_kept_for_recovery": "操作已保留以供恢复。请在准备其他操作前刷新状态。",
				"media_reconnect": "操作需要重新连接。请勿重新发送请求。",
				"media_file_saved": "文件已保存",
				"media_saving": "正在保存…",
				"media_save_file": "保存到 {name}",
				"media_kind_image": "图像",
				"media_kind_video": "视频",
				"media_kind_speech": "语音",
				"media_kind_transcription": "转录",
				"media_project_edit": "编辑图像",
				"media_transcript_note": "在上下文中选中时，续写会使用此转录。原始音频保持保存状态；此时不会重新发送其字节。",
				"media_transcript_meta": "与原始音频关联的转录 · 在上下文中选中时以文本续写",
				"media_result_preserved": "结果已保留。请刷新操作以完成与对话的关联，无需重新执行。",
				"media_output_format_mismatch": "收到的格式与所选目标不同。请以原始格式下载结果。",
				"media_output_decoder_unavailable": "此浏览器无法校验收到的格式。目标已保留；您可以下载原始文件。",
				"media_run_status_unknown": "状态未确认",
				"media_run_status_succeeded": "已完成",
				"media_run_status_failed": "失败",
				"media_run_status_running": "运行中",
				"media_run_status_cancelled": "已取消",
				"media_run_status_awaiting": "等待授权",
				"media_run_status_needs_attention": "需要注意",
				"media_known_provider": "已知提供方",
				"media_select_provider": "选择提供方",
				"media_manage_accounts": "管理账户",
				"media_account_configured": "账户已配置",
				"media_no_image_provider": "尚无已知提供方声明支持图像生成。请管理账户或使用兼容的手动端点。",
				"media_destination": "目标：{name}",
				"media_remove": "移除"
			},
			sensitive: {
				"sensitive_title": "安全输入到本地保险库",
				"sensitive_instruction_label": "正在为 {label} 配置凭据。",
				"sensitive_note": "该值仅发送到本地代理保险库，绝不会写入历史记录、屏幕或导出内容。",
				"sensitive_secret_label": "访问密钥 / 机密",
				"sensitive_secret_placeholder": "在此粘贴访问密钥…",
				"sensitive_saving": "正在保存…",
				"sensitive_retry": "重试",
				"sensitive_save": "保存到保险库",
				"sensitive_cancel": "取消",
				"sensitive_aria": "安全凭据输入",
				"sensitive_connection_fallback": "连接 {provider}",
				"sensitive_error_default": "代理拒绝了该凭据。请查看下方代码并重试。",
				"err_sensitive_target_missing": "未指定连接或提供方。请打开连接设置并选择凭据目标。",
				"err_sensitive_revision_missing": "未提供连接修订。请重新打开连接以使用当前状态。",
				"err_sensitive_connection_id_invalid": "连接标识无效。请从列表中重新打开连接。",
				"err_sensitive_provider_id_invalid": "指定的提供方无效。请从列表中选择提供方。",
				"err_sensitive_revision_conflict": "连接在打开后已更改。请重新打开以使用当前修订。",
				"err_sensitive_connection_not_found": "该连接已不存在。请刷新连接列表。",
				"err_sensitive_unauthorized": "本地会话已过期或被撤销。请重新连接到本地代理后重试。",
				"err_sensitive_rate_limited": "短时间内更改过多。请稍候再试。",
				"err_sensitive_limit_exceeded": "连接数量已达上限。请先删除一个连接再创建新的。",
				"err_sensitive_multiconta_disabled": "同一提供方的多个账户已停用。请使用现有连接。",
				"err_sensitive_invalid_profile": "代理拒绝了连接数据。请检查提供方和输入的密钥。",
				"err_sensitive_invalid_request": "代理拒绝了请求。请检查输入的密钥。",
				"err_sensitive_confirmation_invalid": "代理未确认此连接的写入。未标记为已保存；重试前请刷新列表。",
				"err_sensitive_interrupted": "确认前代理连接中断。重试会复用同一操作，不会重复。"
			}
		},
		ar: {
			common: {
				ok: "موافق",
				cancel: "إلغاء",
				save: "حفظ",
				back: "رجوع",
				confirm: "تأكيد",
				undo: "تراجع"
			},
			shell: {
				proxy_connected: "الوكيل المحلي متصل",
				proxy_degraded: "الوكيل المحلي غير متصل",
				select_model: "حدد النموذج الافتراضي",
				new_chat: "محادثة جديدة"
			},
			composer: {
				placeholder: "اكتب تعليمات أو رسالة...",
				recording_audio: "جاري الاستماع... تحدث الآن",
				transcribing: "جاري معالجة التفريغ الصوتي المحلي...",
				attach_file: "إرفاق ملف",
				link_folder: "ربط مجلد المشروع"
			},
			chat: {
				streaming_tokens: "جاري توليد الرد...",
				stop_generation: "إيقاف التوليد",
				view_details: "عرض التفاصيل الفنية",
				hide_details: "إخفاء التفاصيل"
			},
			w5: {
				consent_title: "طلب تعديل ملف (حكمة W5)",
				approve_change: "الموافقة على التعديل",
				reject_change: "رفض التعديل",
				diff_additions: "{count, plural, zero {لا إضافات} one {إضافة واحدة} two {إضافتان} few {# إضافات} many {# إضافة} other {# إضافة}}",
				diff_deletions: "{count, plural, zero {لا حذف} one {حذف واحد} two {حذفان} few {# عمليات حذف} many {# عملية حذف} other {# عملية حذف}}"
			},
			modals: {
				quota_panel_title: "الاستهلاك والحد الأقصى للميزانية",
				endpoint_panel_title: "خزنة مفاتيح API (BYOK)",
				capability_title: "كتالوج الأدوات وخوادم MCP"
			},
			errors: {
				network_unavailable: "الخدمة غير متوفرة مؤقتاً. تحقق من الاتصال المحلي.",
				quota_exceeded: "تم الوصول إلى الحد الأقصى للميزانية للفترة الحالية.",
				key_expired: "مفتاح API المكوّن في خزنة نظام التشغيل منتهي الصلاحية أو غير صالحة.",
				api_failed: "فشلت مكالمة الخدمة الخارجية. انقر فوق 'التفاصيل' للإجراءات الموصى بها."
			},
			privacy: {
				"privacy_title": "الخصوصية والبيانات",
				"privacy_hint": "تفضيلات وتصديرات الخدمة المحلية. يحدد مزوّد الذكاء الاصطناعي سياسة الاحتفاظ الخاصة به.",
				"privacy_include_exports": "تضمين الرسائل في التصديرات",
				"privacy_notifications": "إشعارات المتصفح",
				"privacy_quiet_hours": "ساعات الهدوء",
				"privacy_quiet_start": "البداية",
				"privacy_quiet_end": "النهاية",
				"privacy_quiet_zone": "المنطقة الزمنية",
				"privacy_save_quiet": "حفظ الساعات",
				"privacy_clear_quiet": "إزالة الساعات",
				"privacy_export_prefs": "تصدير التفضيلات",
				"privacy_export_conversation": "تصدير المحادثة الحالية",
				"privacy_export_receipts": "تصدير الإيصالات المحلية",
				"privacy_files_title": "الملفات المولّدة والإيصالات المحلية",
				"privacy_files_note": "تمنع المراجع وعمليات التنفيذ النشطة الحذف. تبقى هوية عمليات التنفيذ لمنع تكرار العمليات. النسخ المصدَّرة والسجلات الخارجية لها سياسة احتفاظ خاصة بها.",
				"privacy_resource": "المورد",
				"privacy_select": "اختيار",
				"privacy_confirm_resource": "أؤكد حذف المورد المحدد",
				"privacy_delete_resource": "حذف المورد",
				"privacy_conversation_title": "حذف المحادثة الحالية من التخزين المحلي",
				"privacy_conversation_note": "يحذف الإجراء هذه المحادثة من الخدمة المحلية، لكنه لا يحذف النسخ أو السجلات التي يحتفظ بها مقدمو خدمات خارجيون.",
				"privacy_confirm_conversation": "أؤكد حذف هذه المحادثة",
				"privacy_delete_conversation": "حذف المحادثة",
				"privacy_download": "تنزيل النتيجة",
				"privacy_delete_export": "حذف هذا التصدير المخزّن من الخدمة",
				"privacy_refresh_result": "الاطلاع على النتيجة",
				"privacy_refresh": "تحديث",
				"privacy_loading": "جارٍ التحميل…",
				"privacy_blocked_prefix": "لا يمكن الحذف الآن: ",
				"err_privacy_unavailable": "تعذّر تحميل إعدادات الخصوصية. حاول مرة أخرى.",
				"err_privacy_invalid": "أعادت الخدمة المحلية بيانات غير متوقعة. أعد تحميل الصفحة وحاول مرة أخرى.",
				"err_privacy_export": "تعذّر التصدير الآن. تحقق من حالة الخدمة وحاول مرة أخرى.",
				"err_privacy_job": "لم تعد هذه العملية متاحة. ابدأها من جديد.",
				"err_privacy_retention": "لا يمكن حذف هذا العنصر ما دامت هناك مراجع أو عمليات تنفيذ نشطة.",
				"privacy_job_kind_export": "تصدير",
				"privacy_job_state_completed": "مكتمل",
				"privacy_job_state_processing": "قيد المعالجة",
				"privacy_job_state_failed": "فشل",
				"privacy_class_artifact": "ملف مولّد",
				"privacy_class_receipts": "إيصالات محلية",
				"privacy_blocked_unknown": "لا يمكن الحذف الآن. السبب الفني مطويّ بالأسفل.",
				"privacy_job_kind_purge": "حذف",
				"privacy_job_state_cancelled": "ملغاة",
				"privacy_class_export": "تصدير مخزّن",
				"privacy_unknown_value": "قيمة غير معروفة (التفاصيل مطوية)"
			},
			media: {
				"media_connect_service": "اربط خدمة متوافقة للمتابعة.",
				"media_connect_button": "ربط الخدمة",
				"media_prepare_error": "تعذّر تجهيز العملية. لم يتم تنفيذ أي شيء.",
				"media_activate_error": "تعذّر تفعيل الخدمة. تحقق من النموذج ونقطة النهاية والاتصال.",
				"media_model": "النموذج",
				"media_endpoint": "نقطة النهاية",
				"media_reference_url": "عنوان HTTPS عام من مصدر مصرَّح به في الوكيل. سيجلب المزوّد تلك الصورة بعد موافقتك.",
				"media_local_reference_title": "ملف محلي كمرجع",
				"media_local_reference_note": "يستخدم المشغّل عنوان HTTPS عاماً ولا ينشر ملفات محلية. لاستخدام صورة أولية، اضبط دعم frame_images والمصدر العام المسموح به في ملف الفيديو.",
				"media_hint_image": "ستُستخدم هذه المعلومة لتوليد الصور. اختر مزوّداً يقدّم هذه الميزة؛ ويظل التوليد بحاجة إلى موافقتك.",
				"media_hint_video": "ستُستخدم هذه المعلومة لتوليد الفيديو. اختر مزوّداً يقدّم هذه الميزة؛ ويظل التوليد بحاجة إلى موافقتك.",
				"media_hint_speech": "ستُستخدم هذه المعلومة لتحويل النص إلى كلام. اختر مزوّداً يقدّم هذه الميزة؛ ويظل التوليد بحاجة إلى موافقتك.",
				"media_hint_transcription": "ستُستخدم هذه المعلومة لتفريغ الصوت. اختر مزوّداً يقدّم هذه الميزة؛ ويظل التوليد بحاجة إلى موافقتك.",
				"media_load_error": "تعذّر تحميل الخدمة أو استعادة العملية. حاول مرة أخرى.",
				"media_processing_denied": "فعّل معالجة المزوّد في هذه المحادثة لاستخدام هذه الخدمة.",
				"media_result_recover_error": "تعذّر استعادة هذه النتيجة.",
				"media_try_again": "حاول مرة أخرى",
				"media_loading_result": "جارٍ تحميل النتيجة…",
				"media_output_invalid": "لم يجتز الملف المستلم التحقق من الوسائط. حُفظت الوجهة؛ حاول توليد النتيجة مرة أخرى.",
				"media_output_timeout": "تجاوز التحقق من الوسائط الوقت المتاح. حُفظت الوجهة؛ حاول الحفظ مرة أخرى.",
				"media_save_error": "تعذّر حفظ الملف. تظل النتيجة متاحة للتنزيل.",
				"media_loading": "جارٍ التحميل…",
				"media_result_mismatch": "لا تتطابق النتيجة مع إيصالات هذه العملية. حدّث الحالة قبل استخدام الملف.",
				"media_refresh": "تحديث الخدمة",
				"media_cancelled": "أُلغيت العملية",
				"media_cancel": "إلغاء العملية",
				"media_local_only": "معالجة هذه المحادثة مقيّدة بهذا الجهاز. تتطلب الخدمات الخارجية تغيير هذا الخيار في الدردشة.",
				"media_reference_image": "صورة مرجعية",
				"media_initial_image_url": "عنوان الصورة الأولية",
				"media_text_only_note": "الخدمة المتصلة تقدّم التوليد من النص. تتطلب الصور المرجعية إعداد نقطة نهاية تعديل متوافقة.",
				"media_kept_for_recovery": "أُبقيت العملية للاستعادة. حدّث حالتك قبل إعداد عملية أخرى.",
				"media_reconnect": "تحتاج العملية إلى إعادة اتصال. لا تعِد إرسال الطلب.",
				"media_file_saved": "حُفظ الملف",
				"media_saving": "جارٍ الحفظ…",
				"media_save_file": "حفظ في {name}",
				"media_kind_image": "صورة",
				"media_kind_video": "فيديو",
				"media_kind_speech": "صوت",
				"media_kind_transcription": "تفريغ صوتي",
				"media_project_edit": "تعديل الصورة",
				"media_transcript_note": "تستخدم الاستمرارية هذا التفريغ عند اختياره في السياق. يبقى الصوت الأصلي محفوظاً؛ ولا تُعاد إرسال بايتاته في هذه الحالة.",
				"media_transcript_meta": "تفريغ مرتبط بالصوت الأصلي · استمرار نصي عند اختياره في السياق",
				"media_result_preserved": "النتيجة محفوظة. حدّث العملية لإكمال الربط بالمحادثة دون إعادة التنفيذ.",
				"media_output_format_mismatch": "يختلف التنسيق المستلم عن الوجهة المختارة. نزّل النتيجة بصيغتها الأصلية.",
				"media_output_decoder_unavailable": "لا يستطيع هذا المتصفح التحقق من التنسيق المستلم. حُفظت الوجهة؛ ويمكنك تنزيل الأصل.",
				"media_run_status_unknown": "الحالة غير مؤكدة",
				"media_run_status_succeeded": "مكتمل",
				"media_run_status_failed": "فشل",
				"media_run_status_running": "قيد التنفيذ",
				"media_run_status_cancelled": "ملغى",
				"media_run_status_awaiting": "بانتظار الموافقة",
				"media_run_status_needs_attention": "بحاجة إلى اهتمام",
				"media_known_provider": "مزوّد معروف",
				"media_select_provider": "اختيار المزوّد",
				"media_manage_accounts": "إدارة الحسابات",
				"media_account_configured": "الحساب مُهيَّأ",
				"media_no_image_provider": "لا يعلن أي مزوّد معروف عن توليد الصور بعد. أدر الحسابات أو استخدم نقطة نهاية يدوية متوافقة.",
				"media_destination": "الوجهة: {name}",
				"media_remove": "إزالة"
			},
			sensitive: {
				"sensitive_title": "إدخال آمن في الخزنة المحلية",
				"sensitive_instruction_label": "جارٍ إعداد بيانات الاعتماد لـ {label}.",
				"sensitive_note": "تُرسل القيمة إلى خزنة الوكيل المحلي فقط، ولا تُسجَّل أبداً في السجل أو الشاشة أو التصدير.",
				"sensitive_secret_label": "مفتاح الوصول / السر",
				"sensitive_secret_placeholder": "الصق مفتاح الوصول هنا…",
				"sensitive_saving": "جارٍ الحفظ…",
				"sensitive_retry": "إعادة المحاولة",
				"sensitive_save": "الحفظ في الخزنة",
				"sensitive_cancel": "إلغاء",
				"sensitive_aria": "إدخال آمن لبيانات الاعتماد",
				"sensitive_connection_fallback": "اتصال {provider}",
				"sensitive_error_default": "رفض الوكيل بيانات الاعتماد. راجع الرمز أدناه وأعد المحاولة.",
				"err_sensitive_target_missing": "لم يُحدَّد اتصال أو مزوّد. افتح إعدادات الاتصال واختر وجهة بيانات الاعتماد.",
				"err_sensitive_revision_missing": "لم تُقدَّم مراجعة الاتصال. أعد فتح الاتصال لاستخدام الحالة الحالية.",
				"err_sensitive_connection_id_invalid": "معرّف الاتصال غير صالح. أعد فتح الاتصال من القائمة.",
				"err_sensitive_provider_id_invalid": "المزوّد المحدد غير صالح. اختر المزوّد من القائمة.",
				"err_sensitive_revision_conflict": "تغيّر الاتصال منذ فتحه. أعد فتحه لاستخدام المراجعة الحالية.",
				"err_sensitive_connection_not_found": "لم يعد الاتصال موجوداً. حدّث قائمة الاتصالات.",
				"err_sensitive_unauthorized": "انتهت الجلسة المحلية أو أُلغيت. أعد الاتصال بالوكيل المحلي ثم حاول مجدداً.",
				"err_sensitive_rate_limited": "تغييرات كثيرة في وقت قصير. انتظر لحظة ثم أعد المحاولة.",
				"err_sensitive_limit_exceeded": "بلغ حدّ الاتصالات. احذف اتصالاً قبل إنشاء آخر.",
				"err_sensitive_multiconta_disabled": "الحسابات المتعددة لنفس المزوّد معطّلة. استخدم الاتصال الموجود.",
				"err_sensitive_invalid_profile": "رفض الوكيل بيانات الاتصال. راجع المزوّد والمفتاح المُدخل.",
				"err_sensitive_invalid_request": "رفض الوكيل الطلب. راجع المفتاح المُدخل.",
				"err_sensitive_confirmation_invalid": "لم يؤكد الوكيل كتابة هذا الاتصال. لم يُعلَّم شيء كمحفوظ؛ حدّث القائمة قبل إعادة المحاولة.",
				"err_sensitive_interrupted": "انقطع الاتصال بالوكيل قبل التأكيد. إعادة المحاولة تعيد استخدام العملية نفسها دون تكرار."
			}
		}
	};
	/**
	* Returns a flattened dictionary for a language where keys are:
	* - namespace.key (e.g. 'common.ok', 'w5.diff_additions')
	* - and key directly as alias (e.g. 'diff_additions', 'ok')
	*/
	function flattenMasterDict(lang) {
		const ns = MASTER_I18N_NAMESPACED[lang] || MASTER_I18N_NAMESPACED.en;
		const flat = {};
		for (const [namespace, entries] of Object.entries(ns)) for (const [key, value] of Object.entries(entries)) {
			flat[`${namespace}.${key}`] = value;
			if (!flat[key]) flat[key] = value;
		}
		return flat;
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/i18n.ts
	const DICT = {
		en: {
			classification_semantic_title: "Classify with TypeSafe",
			classification_semantic_note: "Analyze only the selected text; the result does not authorize actions.",
			ws_embeddings_title: "Embeddings",
			ws_embeddings_description: "Create vectors with the connected model.",
			ws_automation_schedule_authorize: "Authorize schedule",
			ws_automation_schedule_scope: "Recurring permission limited by scope, count and expiration.",
			ws_automation_channel_resend: "Send with Resend",
			ws_automation_channel_brevo: "Send with Brevo",
			ws_automation_channel_slack: "Send with Slack",
			ws_automation_channel_description: "Send the reviewed message after authorization.",
			df_model_plugin: "Model plugin reference",
			df_plugin_version: "Referenced version",
			df_plugin_hash: "Declared SHA-256",
			df_plugin_note: "Reference declared in the template. No plugin package is installed and no package hash is verified.",
			df_temperature: "Temperature",
			df_top_p: "Top-p",
			df_title: "Import Dify template",
			df_profile: "Supported subset: Start → LLM → End with one text input. Tools, code, RAG, environment variables and tool plugins remain outside this profile. Model plugin references can be read without installation.",
			df_file: "Local YAML file",
			df_file_help: "Up to {bytes} bytes. Read locally; the YAML is not saved.",
			df_source_model: "Model in the template",
			df_target_model: "Configured model for this plan",
			df_mapping: "The original model is shown for reference. The materialized messages use the configured gateway model only, after approval.",
			df_template: "Template",
			df_max_tokens: "Maximum output tokens",
			df_prepare: "Prepare plan",
			df_prepare_note: "Only the materialized template messages are used. Previous chat history, attachments, research sources and the current draft are excluded. Execution requires separate approval.",
			df_file_error: "Choose a non-empty .yaml or .yml file up to {bytes} bytes. Environment files are not accepted.",
			df_invalid: "Template rejected. Use the supported Start → LLM → End profile without unsupported features or settings.",
			df_limit: "The file or YAML structure exceeds the supported limits.",
			df_input_error: "Enter the required text within {max} characters and an output limit from 1 to 4096.",
			df_payload_error: "The materialized template exceeds the 12,000-byte chat limit. Shorten its text or input.",
			df_read_error: "Could not read the selected file.",
			mu_title: "Models and quotas",
			mu_refresh: "Refresh",
			mu_no_models: "No configured model data.",
			mu_provider_scope: "Local quota shared by this provider’s configured models.",
			mu_quota_unknown: "Quota accounting is unavailable.",
			mu_table_note: "Reservations / configured local limits",
			mu_window: "Window",
			mu_reserved_calls: "Reserved calls",
			mu_reserved_tokens: "Reserved tokens",
			mu_minute: "Current minute",
			mu_day: "Current day",
			mu_reservation_note: "Token reservations include estimated input and the maximum output allowance. They are not measured consumption.",
			mu_presented_run: "Presented run",
			mu_usage_unknown: "Measured use unavailable.",
			mu_input_tokens: "Reported input tokens",
			mu_output_tokens: "Reported output tokens",
			mu_receipt_coverage: "Attempts with complete reported usage / attempts in this run",
			mu_subset_note: "Token figures include only reported measurements. Missing measurements remain unknown; these figures are not a total for all usage.",
			mu_router_usage: "Direct proxy calls",
			mu_router_scope: "Successful direct Router responses since this process started. This counter excludes workspace gateway calls and is not persisted.",
			mu_with_usage: "Responses with reported usage",
			mu_without_usage: "Responses without reported usage",
			mu_in_flight: "Responses in progress",
			mu_interrupted: "Interrupted responses",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "Preview truncated. The complete response is available in the final artifact after successful execution.",
			ws_gateway_reconnect: "Reconnect to check the status of this work.",
			ws_gateway_payload: "Messages to send",
			ws_gateway_text_only: "Text only: remove attachments and select no research source.",
			ws_gateway_size: "The complete conversation must fit within 12,000 bytes. Start a new chat or shorten the text.",
			ws_gateway_title: "Chat",
			ws_gateway_description: "Send the displayed messages once, after approval.",
			ws_browser_title: "Local page inspection",
			ws_speech_playback_error: "This audio could not be played. Generation will not be repeated automatically.",
			ws_image_prepare: "Prepare images",
			ws_video_title: "Video",
			ws_video_limits_value: "{calls} calls · {seconds}s total",
			ws_video_description: "Review before sending. Available settings depend on the configured model.",
			ws_video_duration: "Duration (seconds)",
			ws_video_ratio: "Aspect ratio",
			ws_video_resolution: "Resolution",
			ws_video_audio: "Generate audio",
			ws_video_seed: "Seed (optional)",
			ws_video_prepare: "Review video request",
			ws_video_invalid: "Check the video settings or reconnect.",
			ws_video_download: "Download MP4",
			ws_video_load: "Load video",
			ws_video_stop_notice: "Stopping observation does not cancel generation at the provider.",
			ws_video_resume: "Resume tracking",
			ws_video_status_pending: "Queued at the provider",
			ws_video_status_in_progress: "Generating at the provider",
			ws_video_status_completed: "Generation completed at the provider",
			ws_video_status_failed: "Generation failed at the provider",
			ws_video_status_cancelled: "Cancelled by the provider",
			ws_video_status_expired: "Expired at the provider",
			ws_video_poll_title: "Track video",
			ws_video_poll_description: "Read the known job status without creating another video.",
			ws_video_content_title: "Retrieve video",
			ws_video_content_description: "Download the completed job into your workspace.",
			ws_image_title: "Images",
			ws_image_description: "Prepare a plan; images are generated only after authorization. Provider support varies.",
			ws_image_prompt: "Description",
			ws_image_count: "Image count",
			ws_image_size: "Size (auto or WxH)",
			ws_image_quality: "Quality (optional)",
			ws_image_style: "Style (optional)",
			ws_image_load: "Load image",
			ws_image_invalid: "Unable to prepare or load the image. Check the request and connection.",
			ws_image_download: "Download image",
			ws_speech_title: "Generate speech",
			ws_speech_description: "After approval, turn only the text entered below into audio using the displayed model.",
			ws_speech_input: "Text to speak",
			ws_speech_prepare: "Prepare speech plan",
			ws_speech_invalid: "Enter text and keep it within the local limit of 12,000 UTF-8 bytes.",
			ws_speech_result: "Generated audio",
			ws_speech_result_note: "AI-generated audio. Playback starts only when you choose.",
			ws_speech_load: "Load audio",
			ws_speech_loading: "Loading audio…",
			ws_speech_audio_error: "The audio could not be loaded and verified. Try loading it again.",
			ws_speech_limits_value: "{calls} generations · {seconds}s",
			ws_transcription_title: "Transcribe audio",
			ws_transcription_description: "After approval, transcribe the selected audio into reviewable text using the displayed model.",
			ws_transcription_file: "Audio file (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "Language (optional, ISO 639-1)",
			ws_transcription_prepare: "Prepare transcription plan",
			ws_transcription_invalid: "Choose an MP3 file and use a two-letter language code, or leave it blank.",
			ws_transcription_result: "Transcript",
			ws_browser_fill_title: "Fill local page fields",
			ws_browser_fill_description: "After approval, fill the fields shown below and capture the page. The form is not submitted and saving on the server is not confirmed.",
			ws_browser_fill_field: "Field {number}",
			ws_browser_fill_label: "Exact field label",
			ws_browser_fill_value: "Value",
			ws_browser_fill_empty: "An empty value clears the field.",
			ws_browser_fill_add: "Add field",
			ws_browser_fill_prepare: "Prepare for review",
			ws_browser_fill_invalid: "Use a URL within {origin} and 1–8 distinct field labels (up to 200 characters). Each value allows 2,000 characters; shorten the values if the complete request is too large.",
			ws_browser_fill_local: "Only {origin}. Page scripts are disabled.",
			ws_browser_fill_limits_value: "{steps} steps · {calls} actions · {seconds}s",
			ws_browser_description: "Inspect a local page after approval, without clicking or interacting with forms.",
			ws_tools_result_prepare: "Prepare a response with this result",
			project_changeset_title: "Proposed file changes",
			project_changeset_note: "The model proposed these changes. Nothing is written until you approve the plan; the daemon checks hashes before writing.",
			project_apply: "Review and apply",
			project_apply_busy: "Preparing…",
			project_apply_started: "Plan approved. The write run was started; reopen the workspace to see the result.",
			project_apply_bind_first: "Bind the folder through the local proxy before applying changes.",
			project_apply_unavailable: "Applying changes is unavailable in this session.",
			ws_tools_result_consent: "This result will be sent to the model only after you approve the new plan.",
			ws_tools_enable: "Suggest local actions in chat",
			ws_tools_description: "Selected tools let the model propose actions. Each action needs a separate plan and your approval.",
			ws_tools_proposal: "Action proposal",
			ws_tools_not_executed: "This message is a proposal. Preparing an action does not execute it; approve the new plan to execute.",
			ws_tools_prepare: "Prepare this action",
			ws_filesystem_title: "Local file metadata",
			ws_filesystem_tool: "Tool",
			ws_filesystem_path: "Relative path",
			ws_filesystem_list: "List directory",
			ws_filesystem_info: "File information",
			ws_filesystem_description: "Only names and metadata in the configured folder. No file contents or changes.",
			ws_filesystem_unavailable: "Local file tools unavailable.",
			ws_filesystem_invalid: "Check the path or reconnect to refresh available tools, then prepare a new plan.",
			ws_browser_open: "Inspect local page",
			ws_composition_open: "Conditional next step",
			ws_composition_description: "Check a literal, case-sensitive condition in the selected local result. A matching result only proposes a new inspection, which requires separate approval.",
			ws_composition_contains: "If the result contains",
			ws_composition_next: "Propose inspection of this URL",
			ws_composition_check: "Check condition",
			ws_composition_no_match: "The text was not found. No next plan was created.",
			ws_composition_ready: "The condition matched. Review the next plan before approving.",
			ws_composition_review: "This composition needs review. No next step was executed.",
			ws_composition_review_plan: "Review next plan",
			ws_browser_url: "Local page URL",
			ws_browser_prepare: "Prepare inspection",
			ws_browser_invalid: "Enter a complete URL within {origin}. Inspection starts only after approval.",
			ws_browser_limits_value: "{steps} steps · {calls} inspections · {seconds}s",
			ws_download_requested: "Download requested for {name}. Check your browser downloads.",
			title: "Your AI. Real sources.",
			connect: "Connect",
			disconnect: "Disconnect",
			connected: "Connected",
			offline: "Offline",
			connecting: "Connecting…",
			send: "Send",
			stop: "Stop",
			placeholder: "Ask anything… Use @ for models or research sources.",
			hint: "Ctrl+Enter send · Esc stop · mic dictate · @ mentions · attachments",
			model: "Model",
			sources: "Research",
			newChat: "New chat",
			empty_title: "Your AI. Real sources.",
			empty_body: "Connect to the local proxy (127.0.0.1:21435), pick a local or BYOK model, optionally @pubmed / @crossref / @open-library, then ask. Keys stay on this device.",
			you: "You",
			ai: "AI",
			searching: "Searching references…",
			answering: "Thinking…",
			queryLabel: "Search terms",
			queryHint: "At least 2 characters for research search",
			local: "Local",
			cloud: "Cloud BYOK",
			research: "Research",
			connections: "Connections",
			history: "History",
			theme: "Theme",
			theme_dark: "Dark",
			theme_light: "Light",
			theme_auto: "Auto",
			keys_local: "Keys stay on device",
			attach: "Attach files",
			remove: "Remove",
			stop_kept: "Stopped — partial answer kept",
			unknown: "unknown",
			cost_unknown: "cost: unknown",
			fallback_on: "fallback authorized",
			disabled_zai: "research-only / blocked on proxy",
			disabled_openalex: "not admitted on proxy",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "offline",
			runtime_ok: "reachable",
			no_local_models: "No local models discovered yet.",
			no_history: "No saved chats yet. Start one — it stays in this browser.",
			attach_busy: "Reading file…",
			err_provision: "Could not provision — is the proxy on 127.0.0.1:21435?",
			err_request: "Request failed",
			err_source: "Source search failed",
			err_source_rate: "Source rate limited — try again shortly",
			err_capacity: "Local capacity busy — retry",
			err_invalid: "Invalid request",
			menu: "Open sidebar",
			close_menu: "Close sidebar",
			lang: "Language",
			credits: "Credits",
			size_est: "size est.",
			aliases: "Local aliases",
			discovered: "Installed models",
			none_source: "AI only",
			papers: "papers",
			books: "books",
			delete_chat: "Delete",
			composer_disabled: "Connect to the proxy to chat",
			connect_first: "Connect to the proxy to send",
			more_options: "More options",
			hide_options: "Hide options",
			new_project: "New project",
			projects: "Projects",
			project_name: "Project name",
			local_storage: "Stored locally",
			streaming: "Streaming…",
			mic: "Dictate",
			mic_stop: "Stop dictation",
			mic_listening: "Listening…",
			mic_unsupported: "Dictation not supported in this browser",
			mic_denied: "Microphone permission denied",
			mic_error: "Dictation failed",
			sidebar: "Sidebar",
			note_text_read_failed: "Could not read text file — name only.",
			note_pdf_empty: "PDF had no extractable text (name only).",
			note_pdf_unavailable: "PDF text extraction unavailable — attached by name only.",
			note_doc_binary: "Unsupported parse — name only (.doc binary).",
			note_doc_unsupported: "Unsupported parse — name only (docx).",
			note_doc_compressed: "Unsupported parse — name only (docx compressed).",
			note_doc_besteffort: "Best-effort docx text (may be incomplete).",
			note_unsupported_parse: "Unsupported parse — name only.",
			note_image_attached: "Image attached ({name}, {size} bytes). Sent to the model only if it likely supports images; otherwise kept as a local preview.",
			note_image_preview_failed: "Image attached ({name}) — preview failed.",
			note_audio_attached: "Audio attached ({name}, {size} bytes) — this client does not transcribe audio; only name and size are shared.",
			note_unsupported_type: "Unsupported file type — name only ({name}).",
			hint_prefer_local: "Prefer local runtime",
			hint_local_gemma: "Local Gemma match",
			hint_local_qwen: "Local Qwen match",
			hint_auto_route: "Auto route",
			hint_same_as_auto: "Same as uptokey-auto",
			hint_pubmed: "PubMed papers",
			hint_crossref: "Crossref DOIs",
			hint_open_library: "Open Library books",
			hint_local_model: "Local model",
			ws_title: "Research work",
			ws_open: "Research and create report",
			ws_hide: "Hide work panel",
			ws_unavailable: "Workspace execution is not connected yet. The plan, steps, evidence and export appear here once the local workspace is available.",
			ws_contract_mismatch: "This work uses a different contract version than this interface. Values may be incomplete.",
			ws_goal: "What should this work do?",
			ws_goal_placeholder: "e.g. Recent reviews on vitamin D and immunity",
			ws_create: "Create work",
			ws_update: "Update work",
			ws_save_recipe: "Save routine",
			ws_recipe_saved: "Routine saved",
			ws_recipe_note: "A routine keeps parameters and steps. It carries no keys or grants and does not authorize execution by itself.",
			ws_plan: "Plan",
			ws_plan_sources: "Sources",
			ws_plan_destination: "Data destination",
			ws_plan_model: "Model",
			ws_plan_limits: "Limits",
			ws_approve: "Authorize and run",
			ws_approval_note: "Authorization is bound to this plan. A material change requires a new authorization.",
			ws_state_draft: "Draft",
			ws_state_awaiting_approval: "Awaiting authorization",
			ws_state_ready: "Ready",
			ws_state_running: "Running",
			ws_state_succeeded: "Completed",
			ws_state_failed: "Failed",
			ws_state_cancelled: "Interrupted",
			ws_state_needs_attention: "Needs attention",
			ws_steps: "Steps",
			ws_step_prepared: "Prepared",
			ws_step_dispatched: "Sent",
			ws_step_succeeded: "Done",
			ws_step_failed: "Failed",
			ws_step_unknown: "Unknown result",
			ws_step_unknown_note: "Sent without a confirmed result. It is not repeated automatically.",
			ws_step_account_note: "Not sent: the linked account has no current observed balance, enough balance or a known per-unit price. Review it in Accounts.",
			ws_cancel: "Interrupt",
			api_field_pokemon_name: "Pokemon name",
			api_field_owner: "Owner",
			api_field_repo: "Repository",
			api_field_state: "State",
			api_field_page: "Page",
			api_field_per_page: "Per page",
			api_field_indicator: "Indicator",
			api_field_format: "Format",
			api_op_get_public_repository_issues: "Get public repository issues",
			api_op_get_public_repository_pulls: "Get public repository pulls",
			api_op_get_pokemon: "Get Pokemon",
			api_op_get_country_indicator: "Get country indicator",
			api_op_get_apod: "Astronomy picture of the day",
			repoUrl: "Repository URL",
			recipe_param_repoUrl: "Repository URL",
			ws_cancelled_note: "Interrupted. Showing the last saved state.",
			ws_evidence: "Evidence consulted",
			ws_evidence_consulted: "consulted {date}",
			ws_evidence_not_retrieved: "not retrieved",
			ws_evidence_empty: "No source consulted yet.",
			ws_result: "Result",
			ws_delete_confirm: "Permanently delete this workspace project, reports and history? Exported files and original imported data will remain.",
			ws_import: "Import selected context",
			ws_context: "Context for this execution",
			project_choose_folder: "Choose a folder (optional)",
			ws_import_note: "Select messages or saved attachment text to copy locally. Missing attachment text requires attaching the file again. Originals remain unchanged. Reimport opens the existing copy. Nothing is executed.",
			ws_constraints: "Constraints (one per line)",
			ws_compare: "Compare with previous report (− removed, + added)",
			ws_result_open: "Open",
			ws_persisted_note: "Saved in the local workspace. That is not an exported file.",
			ws_export_folder: "Save to project folder",
			ws_export_download: "Download",
			ws_export_done: "Exported as {name}",
			ws_export_failed: "Export failed. The report is still saved in the workspace.",
			ws_export_overwrite: "Overwrite {name} in the project folder?",
			ws_export_no_folder: "No project folder granted in this browser. The grant may need to be repeated after reopening.",
			ws_usage_title: "Your use this month",
			ws_usage_charged: "Charged by Uptokey",
			ws_usage_reference: "Reference value of use",
			ws_usage_reference_note: "Estimate at public reference rates. It is not an invoice and not confirmed savings.",
			ws_usage_coverage: "Measurement coverage",
			ws_usage_coverage_value: "{included} of {observed} calls",
			ws_usage_details: "Check the calculation",
			ws_usage_basis_provider: "reported by provider",
			ws_usage_basis_estimated: "estimated",
			ws_usage_basis_unknown: "unknown basis",
			ws_usage_cov_included: "included",
			ws_usage_cov_missing_usage: "without reported use",
			ws_usage_cov_missing_tariff: "without a rate",
			ws_usage_cov_not_comparable: "not comparable",
			ws_usage_cov_estimated: "estimated use",
			ws_usage_cov_local_cache: "reused locally",
			ws_usage_access_public: "public access",
			ws_usage_access_byok: "your own key",
			ws_usage_access_local: "local execution",
			ws_usage_access_hosted: "hosted access",
			ws_usage_charge_unconfirmed: "Not every call in this period confirmed a charge, so the total is unknown rather than zero.",
			ws_usage_no_aggregable: "No call had both reported use and a matching rate.",
			ws_usage_cached: "{cached} cached in",
			ws_usage_rate: "{input}/M in · {output}/M out",
			ws_usage_reused: "reused answer",
			ws_usage_tariff: "rate {id} · {checkedAt}",
			ws_usage_byok_note: "Charged by Uptokey is not total cost: BYOK can be billed directly by the provider, and a local model uses your own equipment and energy.",
			ws_usage_units: "{input} in · {output} out",
			ws_usage_empty: "No measured call in this period.",
			ws_step_pending: "Pending",
			ws_plan_limits_value: "{steps} steps · {calls} calls · {tokens} out · {seconds}s",
			ws_capability_unavailable: "not executable",
			ws_evidence_note: "A snapshot records what was read at that moment; it does not make the content true.",
			"workflow.sources.crossref.search.title": "Search Crossref",
			"workflow.sources.crossref.search.description": "Looks up articles and DOIs in the public Crossref catalog.",
			"workflow.sources.open-library.search.title": "Search Open Library",
			"workflow.sources.open-library.search.description": "Looks up books and authors in the public Open Library catalog.",
			"workflow.sources.pubmed.search.title": "Search PubMed",
			"workflow.sources.pubmed.search.description": "Looks up biomedical literature in PubMed.",
			"workflow.sources.openalex.search.title": "Search OpenAlex",
			"workflow.sources.openalex.search.description": "Looks up scholarly works in the public OpenAlex catalog.",
			"workflow.sources.archive.search.title": "Search archives",
			"workflow.sources.archive.search.description": "Looks up historical records in the archive source.",
			"workflow.sources.rss.read.title": "Read RSS feed",
			"workflow.sources.rss.read.description": "Fetches entries from a public RSS or Atom feed.",
			"workflow.capabilities.project_write.title": "Write project files",
			"workflow.capabilities.project_write.description": "Creates or edits files inside the authorized project folder.",
			chat_edit: "Edit",
			chat_regenerate: "Regenerate",
			chat_save_submit: "Save & submit",
			chat_cancel_edit: "Cancel",
			cap_discovery_title: "Capability discovery",
			cap_discovery_search_placeholder: "Search capabilities by name, tag, or destination...",
			cap_filter_all: "All",
			cap_filter_available: "Available",
			cap_filter_configurable: "Configurable",
			cap_filter_unavailable: "Unavailable",
			cap_tier_available: "Available",
			cap_tier_configurable: "Configurable",
			cap_tier_unavailable: "Unavailable",
			cap_action_open_form: "Open form",
			cap_action_prepare: "Prepare plan",
			cap_action_configure: "Configure",
			cap_action_unavailable: "Unavailable",
			cap_action_details: "Details",
			cap_action_hide_details: "Hide details",
			cap_action_clear_search: "Clear search",
			cap_filter_group_label: "Filter capabilities by availability",
			cap_label_destination: "Destination",
			cap_label_effect: "Effect",
			cap_label_limits: "Execution limits",
			cap_label_tags: "Tags",
			cap_label_schemas: "Input/Output schemas",
			cap_label_retry_class: "Retry policy",
			cap_empty_title: "No capabilities found",
			cap_empty_desc: "No capabilities match the current search or filters.",
			cap_empty_unregistered: "No capabilities have been registered in this workspace yet.",
			cap_reason_executable: "Ready to prepare execution plan",
			cap_reason_catalogued: "Catalogued: requires additional configuration or setup",
			cap_reason_missing_scopes: "Requires permissions: {scopes}",
			cap_reason_scopes_unknown: "Permissions unconfirmed; requires: {scopes}",
			cap_reason_unavailable: "Not executable in this environment",
			cap_reason_incompatible_schema: "Incompatible or incomplete capability metadata",
			cap_reason_unknown: "Descriptor metadata is incomplete or unrecognized",
			cap_unknown_title: "Capability: {id}",
			cap_unknown_desc: "Descriptor metadata is unavailable.",
			cap_effect_read_external: "External read",
			cap_effect_write_external: "External write",
			cap_effect_inference: "Inference",
			cap_effect_produce_artifact: "Produce artifact",
			cap_effect_execute_local: "Run locally",
			cap_destination_public: "Public: {id}",
			cap_destination_local: "Local: {id}",
			cap_destination_provider: "Provider: {id}",
			cap_destination_unknown: "Destination: {id}",
			cap_limits: "{steps} steps · {calls} calls · {tokens} tokens · {timeout}s",
			cap_results_count: "{count} capabilities found",
			cap_results_sr: "Showing {count} capabilities",
			cx_accounts_title: "Accounts and permissions",
			cx_connections_loading: "Loading connections…",
			cx_connections_failed: "Could not load connections. Please try again.",
			cx_connections_retry: "Try again",
			cx_accounts_sub: "One provider, several accounts. Keys stay on this device.",
			cx_add_account: "Add account",
			cx_provider_id: "Provider ID",
			cx_access_mode: "Access mode",
			cx_get_access: "Get access",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "Configure",
			cx_label: "Label",
			cx_secret: "Key",
			cx_secret_hint: "Leave empty to cancel.",
			cx_endpoint: "Endpoint",
			cx_models: "Models (comma separated)",
			cx_add: "Add",
			cx_save: "Save",
			cx_test: "Test",
			cx_test_all: "Test all",
			cx_test_inference: "Test with provider calls",
			cx_testing: "Testing…",
			cx_consent: "Allow capped provider calls",
			cx_cap_usd: "Cap (USD)",
			cx_cancel: "Cancel",
			cx_revoke: "Revoke",
			cx_confirm_revoke: "Click again to confirm revoke",
			cx_reconnect: "Reconnect",
			cx_rename: "Rename",
			cx_disable: "Disable",
			cx_enable: "Enable",
			cx_primary: "Make primary",
			cx_install: "Download",
			cx_model: "Model",
			cx_size_unknown: "Size unavailable",
			cx_no_accounts: "No accounts yet. Add the first one to test it here.",
			cx_resume: "Resume",
			cx_connect_oauth: "Connect with {provider}",
			cx_error: "Error: {type}",
			cx_job_state: "Job: {state}",
			cx_st_healthy: "Healthy",
			cx_st_degraded: "Degraded",
			cx_st_unauthenticated: "No key",
			cx_st_disabled: "Disabled",
			cx_st_unconfigured: "Not configured",
			cx_st_unknown: "Unknown",
			cx_st_expired: "Expired",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "Unauthorized",
			cx_rs_rate_limited: "Rate limited",
			cx_rs_timeout: "Timeout",
			cx_rs_unreachable: "Unreachable",
			cx_rs_skipped: "Skipped",
			cx_rs_failed: "Failed",
			cap_scope_required: "Requires scopes",
			cap_no_action_available: "Reference capability: no direct execution form in this workspace",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		"pt-BR": {
			classification_semantic_title: "Classificar com TypeSafe",
			classification_semantic_note: "Analisar somente o texto selecionado; o resultado não autoriza ações.",
			ws_embeddings_title: "Embeddings",
			ws_embeddings_description: "Criar vetores com o modelo conectado.",
			ws_automation_schedule_authorize: "Autorizar agenda",
			ws_automation_schedule_scope: "Permissão recorrente limitada por escopo, quantidade e validade.",
			ws_automation_channel_resend: "Enviar com Resend",
			ws_automation_channel_brevo: "Enviar com Brevo",
			ws_automation_channel_slack: "Enviar com Slack",
			ws_automation_channel_description: "Enviar a mensagem revisada após autorização.",
			df_model_plugin: "Referência do plugin de modelo",
			df_plugin_version: "Versão referenciada",
			df_plugin_hash: "SHA-256 declarado",
			df_plugin_note: "Referência declarada no template. Nenhum pacote de plugin é instalado e nenhum hash de pacote é verificado.",
			df_temperature: "Temperatura",
			df_top_p: "Top-p",
			df_title: "Importar template Dify",
			df_profile: "Perfil suportado: início → LLM → fim com uma entrada de texto. Ferramentas, código, RAG, variáveis de ambiente e plugins de ferramentas ficam fora deste perfil. Referências de plugins de modelo podem ser lidas sem instalação.",
			df_file: "Arquivo YAML local",
			df_file_help: "Até {bytes} bytes. Leitura local; o YAML não é salvo.",
			df_source_model: "Modelo no template",
			df_target_model: "Modelo configurado para este plano",
			df_mapping: "O modelo original é exibido como referência. As mensagens materializadas usam somente o modelo configurado no gateway, após aprovação.",
			df_template: "Template",
			df_max_tokens: "Máximo de tokens de saída",
			df_prepare: "Preparar plano",
			df_prepare_note: "Somente as mensagens materializadas do template são usadas. Histórico anterior, anexos, fontes de pesquisa e o rascunho atual ficam excluídos. A execução exige aprovação separada.",
			df_file_error: "Escolha um arquivo .yaml ou .yml não vazio de até {bytes} bytes. Arquivos de ambiente não são aceitos.",
			df_invalid: "Template rejeitado. Use o perfil início → LLM → fim, sem recursos ou configurações não suportados.",
			df_limit: "O arquivo ou a estrutura YAML excede os limites suportados.",
			df_input_error: "Preencha o texto obrigatório com até {max} caracteres e um limite de saída entre 1 e 4096.",
			df_payload_error: "O template materializado excede o limite de 12.000 bytes do chat. Reduza o texto ou a entrada.",
			df_read_error: "Não foi possível ler o arquivo selecionado.",
			mu_title: "Modelos e cotas",
			mu_refresh: "Atualizar",
			mu_no_models: "Nenhum dado de modelo configurado.",
			mu_provider_scope: "Cota local compartilhada pelos modelos configurados deste provedor.",
			mu_quota_unknown: "Contabilização da cota indisponível.",
			mu_table_note: "Reservas / limites locais configurados",
			mu_window: "Período",
			mu_reserved_calls: "Chamadas reservadas",
			mu_reserved_tokens: "Tokens reservados",
			mu_minute: "Minuto atual",
			mu_day: "Dia atual",
			mu_reservation_note: "As reservas de tokens incluem a entrada estimada e o máximo de saída permitido. Elas não representam consumo medido.",
			mu_presented_run: "Execução apresentada",
			mu_usage_unknown: "Consumo medido indisponível.",
			mu_input_tokens: "Tokens de entrada informados",
			mu_output_tokens: "Tokens de saída informados",
			mu_receipt_coverage: "Tentativas com consumo completo informado / tentativas desta execução",
			mu_subset_note: "Os valores incluem apenas as medições informadas. Medições ausentes permanecem desconhecidas; estes valores não representam todo o consumo.",
			mu_router_usage: "Chamadas diretas do proxy",
			mu_router_scope: "Respostas diretas bem-sucedidas do Router desde o início deste processo. Este contador exclui chamadas do gateway do workspace e não é persistido.",
			mu_with_usage: "Respostas com consumo informado",
			mu_without_usage: "Respostas sem consumo informado",
			mu_in_flight: "Respostas em andamento",
			mu_interrupted: "Respostas interrompidas",
			bm_title: "Comparação de modelos",
			bm_back: "Voltar",
			bm_start_explicit: "Executar probe ativo",
			bm_no_autorun_note: "Abrir este painel não inicia um benchmark. Probes ativos exigem início explícito.",
			bm_filter: "Filtrar modelos",
			bm_filter_placeholder: "Filtrar por modelo ou provedor",
			bm_empty: "Nenhum ranking carregado. Carregue ou execute um probe para comparar.",
			bm_metric: "Métrica",
			bm_method: "Método",
			bm_cohort: "Coorte",
			bm_n: "n",
			bm_source_date: "Data da fonte",
			bm_table_caption: "Tabela de comparação",
			bm_model: "Modelo",
			bm_score: "Pontuação",
			bm_source: "Fonte",
			bm_tools: "Ferramentas",
			bm_tools_yes: "Sim",
			bm_tools_no: "Não",
			bm_exclusions: "Exclusões",
			bm_observations: "Observações",
			bm_stale: "Desatualizado",
			ws_gateway_preview_truncated: "Prévia truncada. A resposta completa fica no artefato final após a execução concluir com sucesso.",
			ws_gateway_reconnect: "Reconecte para consultar o estado deste trabalho.",
			ws_gateway_payload: "Mensagens que serão enviadas",
			ws_gateway_text_only: "Somente texto: remova anexos e selecione nenhuma fonte de pesquisa.",
			ws_gateway_size: "A conversa completa deve caber em 12.000 bytes. Inicie outro chat ou reduza o texto.",
			ws_gateway_title: "Conversa",
			ws_gateway_description: "Envie as mensagens exibidas uma única vez, após aprovação.",
			ws_browser_title: "Inspeção de página local",
			ws_speech_playback_error: "Não foi possível reproduzir este áudio. A geração não será repetida automaticamente.",
			ws_image_prepare: "Preparar imagens",
			ws_video_title: "Vídeo",
			ws_video_limits_value: "{calls} chamadas · {seconds}s no total",
			ws_video_description: "Revise antes de enviar. As opções disponíveis dependem do modelo configurado.",
			ws_video_duration: "Duração (segundos)",
			ws_video_ratio: "Proporção",
			ws_video_resolution: "Resolução",
			ws_video_audio: "Gerar áudio",
			ws_video_seed: "Semente (opcional)",
			ws_video_prepare: "Revisar pedido de vídeo",
			ws_video_invalid: "Confira as opções do vídeo ou reconecte.",
			ws_video_download: "Baixar MP4",
			ws_video_load: "Carregar vídeo",
			ws_video_stop_notice: "Parar o acompanhamento não cancela a geração no provedor.",
			ws_video_resume: "Retomar acompanhamento",
			ws_video_status_pending: "Na fila do provedor",
			ws_video_status_in_progress: "Gerando no provedor",
			ws_video_status_completed: "Geração concluída no provedor",
			ws_video_status_failed: "Geração falhou no provedor",
			ws_video_status_cancelled: "Cancelado pelo provedor",
			ws_video_status_expired: "Expirado no provedor",
			ws_video_poll_title: "Acompanhar vídeo",
			ws_video_poll_description: "Consultar o pedido conhecido sem criar outro vídeo.",
			ws_video_content_title: "Obter vídeo",
			ws_video_content_description: "Baixar o resultado concluído para seu espaço de trabalho.",
			ws_image_title: "Imagens",
			ws_image_description: "Prepare um plano; as imagens só são geradas após autorização. O suporte varia por provedor.",
			ws_image_prompt: "Descrição",
			ws_image_count: "Quantidade de imagens",
			ws_image_size: "Tamanho (auto ou LxA)",
			ws_image_quality: "Qualidade (opcional)",
			ws_image_style: "Estilo (opcional)",
			ws_image_load: "Carregar imagem",
			ws_image_invalid: "Não foi possível preparar ou carregar a imagem. Confira o pedido e a conexão.",
			ws_image_download: "Baixar imagem",
			ws_speech_title: "Gerar voz",
			ws_speech_description: "Após aprovação, transforme somente o texto informado abaixo em áudio com o modelo exibido.",
			ws_speech_input: "Texto para falar",
			ws_speech_prepare: "Preparar plano de voz",
			ws_speech_invalid: "Informe um texto dentro do limite local de 12.000 bytes em UTF-8.",
			ws_speech_result: "Áudio gerado",
			ws_speech_result_note: "Áudio gerado por IA. A reprodução começa somente quando você escolher.",
			ws_speech_load: "Carregar áudio",
			ws_speech_loading: "Carregando áudio…",
			ws_speech_audio_error: "Não foi possível carregar e verificar o áudio. Tente carregá-lo novamente.",
			ws_speech_limits_value: "{calls} gerações · {seconds}s",
			ws_transcription_title: "Transcrever áudio",
			ws_transcription_description: "Após aprovação, transcreva o áudio escolhido em texto revisável usando o modelo exibido.",
			ws_transcription_file: "Arquivo de áudio (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "Idioma (opcional, ISO 639-1)",
			ws_transcription_prepare: "Preparar plano de transcrição",
			ws_transcription_invalid: "Escolha um arquivo MP3 e use um código de idioma de duas letras, ou deixe em branco.",
			ws_transcription_result: "Transcrição",
			ws_browser_fill_title: "Preencher campos da página local",
			ws_browser_fill_description: "Após aprovação, preencha os campos mostrados abaixo e capture a página. O formulário não é enviado e não há confirmação de gravação no servidor.",
			ws_browser_fill_field: "Campo {number}",
			ws_browser_fill_label: "Rótulo exato do campo",
			ws_browser_fill_value: "Valor",
			ws_browser_fill_empty: "Um valor vazio limpa o campo.",
			ws_browser_fill_add: "Adicionar campo",
			ws_browser_fill_prepare: "Preparar para revisão",
			ws_browser_fill_invalid: "Use uma URL da origem {origin} e 1–8 rótulos distintos (até 200 caracteres). Cada valor aceita 2.000 caracteres; reduza os valores se a solicitação completa ficar grande demais.",
			ws_browser_fill_local: "Somente {origin}. Os scripts da página ficam desativados.",
			ws_browser_fill_limits_value: "{steps} etapas · {calls} ações · {seconds}s",
			ws_browser_description: "Inspecione uma página local após aprovação, sem cliques nem interação com formulários.",
			ws_tools_result_prepare: "Preparar resposta com este resultado",
			project_changeset_title: "Alterações de arquivo propostas",
			project_changeset_note: "O modelo propôs estas alterações. Nada é gravado antes de você aprovar o plano; o daemon confere os hashes antes de escrever.",
			project_apply: "Revisar e aplicar",
			project_apply_busy: "Preparando…",
			project_apply_started: "Plano aprovado. A execução de escrita foi iniciada; reabra o workspace para ver o resultado.",
			project_apply_bind_first: "Vincule a pasta pelo proxy local antes de aplicar alterações.",
			project_apply_unavailable: "A aplicação de alterações não está disponível nesta sessão.",
			ws_tools_result_consent: "Este resultado será enviado ao modelo somente após você aprovar o novo plano.",
			ws_tools_enable: "Sugerir ações locais no chat",
			ws_tools_description: "As ferramentas selecionadas permitem ao modelo propor ações. Cada ação exige um plano separado e sua aprovação.",
			ws_tools_proposal: "Proposta de ação",
			ws_tools_not_executed: "Esta mensagem é uma proposta. Preparar uma ação não a executa; aprove o novo plano para executar.",
			ws_tools_prepare: "Preparar esta ação",
			ws_filesystem_title: "Metadados de arquivos locais",
			ws_filesystem_tool: "Ferramenta",
			ws_filesystem_path: "Caminho relativo",
			ws_filesystem_list: "Listar diretório",
			ws_filesystem_info: "Informações do arquivo",
			ws_filesystem_description: "Somente nomes e metadados na pasta configurada. Sem conteúdo ou alterações de arquivos.",
			ws_filesystem_unavailable: "Ferramentas de arquivos locais indisponíveis.",
			ws_filesystem_invalid: "Confira o caminho ou reconecte para atualizar as ferramentas e prepare um novo plano.",
			ws_browser_open: "Inspecionar página local",
			ws_composition_open: "Próxima etapa condicional",
			ws_composition_description: "Confira um texto literal, diferenciando maiúsculas e minúsculas, no resultado local selecionado. A correspondência apenas propõe outra inspeção, que exige nova aprovação.",
			ws_composition_contains: "Se o resultado contiver",
			ws_composition_next: "Propor inspeção desta URL",
			ws_composition_check: "Conferir condição",
			ws_composition_no_match: "O texto não foi encontrado. Nenhum próximo plano foi criado.",
			ws_composition_ready: "A condição correspondeu. Revise o próximo plano antes de aprovar.",
			ws_composition_review: "Esta composição precisa de revisão. Nenhuma próxima etapa foi executada.",
			ws_composition_review_plan: "Revisar próximo plano",
			ws_browser_url: "URL da página local",
			ws_browser_prepare: "Preparar inspeção",
			ws_browser_invalid: "Informe uma URL completa da origem {origin}. A inspeção começa somente após aprovação.",
			ws_browser_limits_value: "{steps} etapas · {calls} inspeções · {seconds}s",
			ws_download_requested: "Download solicitado para {name}. Confira os downloads do navegador.",
			title: "Sua IA. Fontes reais.",
			connect: "Conectar",
			disconnect: "Desconectar",
			connected: "Conectado",
			offline: "Offline",
			connecting: "Conectando…",
			send: "Enviar",
			stop: "Parar",
			placeholder: "Pergunte… Use @ para modelos ou fontes de pesquisa.",
			hint: "Ctrl+Enter envia · Esc para · @ menções · anexos ok",
			model: "Modelo",
			sources: "Pesquisa",
			newChat: "Nova conversa",
			empty_title: "Sua IA. Fontes reais.",
			empty_body: "Conecte ao proxy local (127.0.0.1:21435), escolha um modelo local ou BYOK, opcionalmente @pubmed / @crossref / @open-library, e pergunte. As chaves ficam neste dispositivo.",
			you: "Você",
			ai: "IA",
			searching: "Buscando referências…",
			answering: "Pensando…",
			queryLabel: "Termos de busca",
			queryHint: "Mínimo 2 caracteres para pesquisa",
			local: "Local",
			cloud: "Cloud BYOK",
			research: "Pesquisa",
			connections: "Conexões",
			history: "Histórico",
			theme: "Tema",
			theme_dark: "Escuro",
			theme_light: "Claro",
			theme_auto: "Auto",
			keys_local: "Chaves ficam no dispositivo",
			attach: "Anexar arquivos",
			remove: "Remover",
			stop_kept: "Parado — resposta parcial mantida",
			unknown: "desconhecido",
			cost_unknown: "custo: desconhecido",
			fallback_on: "fallback autorizado",
			disabled_zai: "somente pesquisa / bloqueado no proxy",
			disabled_openalex: "não admitido no proxy",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "offline",
			runtime_ok: "alcançável",
			no_local_models: "Nenhum modelo local descoberto ainda.",
			no_history: "Nenhuma conversa salva. Comece uma — fica neste navegador.",
			attach_busy: "Lendo arquivo…",
			err_provision: "Falha ao provisionar — o proxy está em 127.0.0.1:21435?",
			err_request: "Falha na requisição",
			err_source: "Falha na busca de fontes",
			err_source_rate: "Limite de fontes — tente em breve",
			err_capacity: "Capacidade local ocupada — tente de novo",
			err_invalid: "Pedido inválido",
			menu: "Abrir menu",
			close_menu: "Fechar menu",
			lang: "Idioma",
			credits: "Créditos",
			size_est: "tam. est.",
			aliases: "Aliases locais",
			discovered: "Modelos instalados",
			none_source: "Só IA",
			papers: "artigos",
			books: "livros",
			delete_chat: "Excluir",
			composer_disabled: "Conecte ao proxy para conversar",
			connect_first: "Conecte ao proxy para enviar",
			more_options: "Mais opções",
			hide_options: "Ocultar opções",
			new_project: "Novo projeto",
			projects: "Projetos",
			project_name: "Nome do projeto",
			local_storage: "Armazenado localmente",
			streaming: "Transmitindo…",
			mic: "Ditar",
			mic_stop: "Parar ditado",
			mic_listening: "Ouvindo…",
			mic_unsupported: "Ditado não suportado neste navegador",
			mic_denied: "Permissão do microfone negada",
			mic_error: "Falha no ditado",
			sidebar: "Barra lateral",
			note_text_read_failed: "Não foi possível ler o arquivo de texto — só o nome.",
			note_pdf_empty: "PDF sem texto extraível (só o nome).",
			note_pdf_unavailable: "Extração de texto do PDF indisponível — anexado só pelo nome.",
			note_doc_binary: "Leitura não suportada — só o nome (.doc binário).",
			note_doc_unsupported: "Leitura não suportada — só o nome (docx).",
			note_doc_compressed: "Leitura não suportada — só o nome (docx compactado).",
			note_doc_besteffort: "Texto do docx extraído de forma aproximada (pode estar incompleto).",
			note_unsupported_parse: "Leitura não suportada — só o nome.",
			note_image_attached: "Imagem anexada ({name}, {size} bytes). Enviada ao modelo só se ele provavelmente aceitar imagens; senão, fica só como pré-visualização local.",
			note_image_preview_failed: "Imagem anexada ({name}) — falha ao gerar pré-visualização.",
			note_audio_attached: "Áudio anexado ({name}, {size} bytes) — este cliente não transcreve áudio; só nome e tamanho são compartilhados.",
			note_unsupported_type: "Tipo de arquivo não suportado — só o nome ({name}).",
			hint_prefer_local: "Prefere runtime local",
			hint_local_gemma: "Modelo Gemma local",
			hint_local_qwen: "Modelo Qwen local",
			hint_auto_route: "Roteamento automático",
			hint_same_as_auto: "Igual a uptokey-auto",
			hint_pubmed: "Artigos do PubMed",
			hint_crossref: "DOIs do Crossref",
			hint_open_library: "Livros do Open Library",
			hint_local_model: "Modelo local",
			ws_title: "Trabalho de pesquisa",
			ws_open: "Pesquisar e criar relatório",
			ws_hide: "Ocultar painel do trabalho",
			ws_unavailable: "A execução do workspace ainda não está conectada. O plano, as etapas, as evidências e a exportação aparecem aqui quando o workspace local estiver disponível.",
			ws_contract_mismatch: "Este trabalho usa uma versão de contrato diferente desta interface. Os valores podem estar incompletos.",
			ws_goal: "O que este trabalho deve fazer?",
			ws_goal_placeholder: "ex.: Revisões recentes sobre vitamina D e imunidade",
			ws_create: "Criar trabalho",
			ws_update: "Atualizar trabalho",
			ws_save_recipe: "Salvar rotina",
			ws_recipe_saved: "Rotina salva",
			ws_recipe_note: "Uma rotina guarda parâmetros e etapas. Não carrega chaves nem permissões e não autoriza execução por si só.",
			ws_plan: "Plano",
			ws_plan_sources: "Fontes",
			ws_plan_destination: "Destino dos dados",
			ws_plan_model: "Modelo",
			ws_plan_limits: "Limites",
			ws_approve: "Autorizar e executar",
			ws_approval_note: "A autorização está vinculada a este plano. Uma alteração material exige nova autorização.",
			ws_state_draft: "Rascunho",
			ws_state_awaiting_approval: "Aguardando autorização",
			ws_state_ready: "Pronto",
			ws_state_running: "Executando",
			ws_state_succeeded: "Concluído",
			ws_state_failed: "Falhou",
			ws_state_cancelled: "Interrompido",
			ws_state_needs_attention: "Precisa de atenção",
			ws_steps: "Etapas",
			ws_step_prepared: "Preparada",
			ws_step_dispatched: "Enviada",
			ws_step_succeeded: "Concluída",
			ws_step_failed: "Falhou",
			ws_step_unknown: "Resultado desconhecido",
			ws_step_unknown_note: "Enviada sem resultado confirmado. Não é repetida automaticamente.",
			ws_step_account_note: "Não enviado: a conta vinculada não tem saldo observado vigente, saldo suficiente ou preço por unidade conhecido. Revise em Contas.",
			ws_cancel: "Interromper",
			api_field_pokemon_name: "Nome do Pokemon",
			api_field_owner: "Proprietário",
			api_field_repo: "Repositório",
			api_field_state: "Estado",
			api_field_page: "Página",
			api_field_per_page: "Por página",
			api_field_indicator: "Indicador",
			api_field_format: "Formato",
			api_op_get_public_repository_issues: "Obter issues do repositório público",
			api_op_get_public_repository_pulls: "Obter pulls do repositório público",
			api_op_get_pokemon: "Obter Pokemon",
			api_op_get_country_indicator: "Obter indicador de país",
			api_op_get_apod: "Imagem astronômica do dia",
			repoUrl: "URL do repositório",
			recipe_param_repoUrl: "URL do repositório",
			ws_cancelled_note: "Interrompido. Mostrando o último estado salvo.",
			ws_evidence: "Evidências consultadas",
			ws_evidence_consulted: "consultada em {date}",
			ws_evidence_not_retrieved: "não recuperada",
			ws_evidence_empty: "Nenhuma fonte consultada ainda.",
			ws_result: "Resultado",
			ws_delete_confirm: "Excluir permanentemente este projeto do workspace, seus relatórios e histórico? Arquivos exportados e dados originais importados serão preservados.",
			ws_import: "Importar contexto selecionado",
			ws_context: "Contexto para esta execução",
			project_choose_folder: "Escolher uma pasta (opcional)",
			ws_import_note: "Selecione mensagens ou textos de anexos salvos para copiar localmente. Se o texto do anexo não foi salvo, anexe o arquivo novamente. Os originais são preservados. Reimportar abre a cópia existente. Nada é executado.",
			ws_constraints: "Restrições (uma por linha)",
			ws_compare: "Comparar com relatório anterior (− removido, + adicionado)",
			ws_result_open: "Abrir",
			ws_persisted_note: "Salvo no workspace local. Isso não é um arquivo exportado.",
			ws_export_folder: "Salvar na pasta do projeto",
			ws_export_download: "Baixar",
			ws_export_done: "Exportado como {name}",
			ws_export_failed: "Falha na exportação. O relatório continua salvo no workspace.",
			ws_export_overwrite: "Sobrescrever {name} na pasta do projeto?",
			ws_export_no_folder: "Nenhuma pasta de projeto concedida neste navegador. A concessão pode precisar ser refeita após reabrir.",
			ws_usage_title: "Seu uso neste mês",
			ws_usage_charged: "Cobrado pelo Uptokey",
			ws_usage_reference: "Valor de referência do uso",
			ws_usage_reference_note: "Estimativa pelas tarifas públicas de referência. Não é fatura nem economia confirmada.",
			ws_usage_coverage: "Cobertura da medição",
			ws_usage_coverage_value: "{included} de {observed} chamadas",
			ws_usage_details: "Conferir o cálculo",
			ws_usage_basis_provider: "reportado pelo provedor",
			ws_usage_basis_estimated: "estimado",
			ws_usage_basis_unknown: "base desconhecida",
			ws_usage_cov_included: "incluída",
			ws_usage_cov_missing_usage: "sem uso reportado",
			ws_usage_cov_missing_tariff: "sem tarifa",
			ws_usage_cov_not_comparable: "não comparável",
			ws_usage_cov_estimated: "uso estimado",
			ws_usage_cov_local_cache: "reutilizada localmente",
			ws_usage_access_public: "acesso público",
			ws_usage_access_byok: "sua própria chave",
			ws_usage_access_local: "execução local",
			ws_usage_access_hosted: "acesso hospedado",
			ws_usage_charge_unconfirmed: "Nem toda chamada deste período confirmou cobrança, então o total fica desconhecido em vez de zero.",
			ws_usage_no_aggregable: "Nenhuma chamada teve uso reportado e tarifa correspondente ao mesmo tempo.",
			ws_usage_cached: "{cached} em cache",
			ws_usage_rate: "{input}/M entrada · {output}/M saída",
			ws_usage_reused: "resposta reutilizada",
			ws_usage_tariff: "tarifa {id} · {checkedAt}",
			ws_usage_byok_note: "Cobrado pelo Uptokey não é o custo total: BYOK pode ser cobrado diretamente pelo provedor e um modelo local consome seu próprio equipamento e energia.",
			ws_usage_units: "{input} entrada · {output} saída",
			ws_usage_empty: "Nenhuma chamada medida neste período.",
			ws_step_pending: "Pendente",
			ws_plan_limits_value: "{steps} etapas · {calls} chamadas · {tokens} saída · {seconds}s",
			ws_capability_unavailable: "não executável",
			ws_evidence_note: "O snapshot registra o que foi lido naquele momento; isso não torna o conteúdo verdadeiro.",
			"workflow.sources.crossref.search.title": "Buscar no Crossref",
			"workflow.sources.crossref.search.description": "Procura artigos e DOIs no catálogo público do Crossref.",
			"workflow.sources.open-library.search.title": "Buscar no Open Library",
			"workflow.sources.open-library.search.description": "Procura livros e autores no catálogo público do Open Library.",
			"workflow.sources.pubmed.search.title": "Buscar no PubMed",
			"workflow.sources.pubmed.search.description": "Procura literatura biomédica no PubMed.",
			"workflow.sources.openalex.search.title": "Buscar no OpenAlex",
			"workflow.sources.openalex.search.description": "Procura trabalhos acadêmicos no catálogo público do OpenAlex.",
			"workflow.sources.archive.search.title": "Buscar em arquivos históricos",
			"workflow.sources.archive.search.description": "Procura registros históricos na fonte de arquivo.",
			"workflow.sources.rss.read.title": "Ler feed RSS",
			"workflow.sources.rss.read.description": "Busca entradas de um feed RSS ou Atom público.",
			"workflow.capabilities.project_write.title": "Escrever arquivos do projeto",
			"workflow.capabilities.project_write.description": "Cria ou edita arquivos dentro da pasta autorizada do projeto.",
			chat_edit: "Editar",
			chat_regenerate: "Regenerar",
			chat_save_submit: "Salvar e enviar",
			chat_cancel_edit: "Cancelar",
			cap_discovery_title: "Descoberta de capacidades",
			cap_discovery_search_placeholder: "Buscar capacidades por nome, tag ou destino...",
			cap_filter_all: "Todas",
			cap_filter_available: "Disponíveis",
			cap_filter_configurable: "Configuráveis",
			cap_filter_unavailable: "Indisponíveis",
			cap_tier_available: "Disponível",
			cap_tier_configurable: "Configurável",
			cap_tier_unavailable: "Indisponível",
			cap_action_open_form: "Abrir formulário",
			cap_action_prepare: "Preparar plano",
			cap_action_configure: "Configurar",
			cap_action_unavailable: "Indisponível",
			cap_action_details: "Detalhes",
			cap_action_hide_details: "Ocultar detalhes",
			cap_action_clear_search: "Limpar busca",
			cap_filter_group_label: "Filtrar capacidades por disponibilidade",
			cap_label_destination: "Destino",
			cap_label_effect: "Efeito",
			cap_label_limits: "Limites de execução",
			cap_label_tags: "Etiquetas",
			cap_label_schemas: "Esquemas de entrada/saída",
			cap_label_retry_class: "Política de repetição",
			cap_empty_title: "Nenhuma capacidade encontrada",
			cap_empty_desc: "Nenhuma capacidade corresponde à busca ou filtros atuais.",
			cap_empty_unregistered: "Nenhuma capacidade foi registrada neste workspace ainda.",
			cap_reason_executable: "Pronta para preparar plano de execução",
			cap_reason_catalogued: "Catalogada: requer configuração adicional",
			cap_reason_missing_scopes: "Requer permissões: {scopes}",
			cap_reason_scopes_unknown: "Permissões não confirmadas; requer: {scopes}",
			cap_reason_unavailable: "Não executável neste ambiente",
			cap_reason_incompatible_schema: "Metadados da capacidade incompatíveis ou incompletos",
			cap_reason_unknown: "Metadados do descritor incompletos ou não reconhecidos",
			cap_unknown_title: "Capacidade: {id}",
			cap_unknown_desc: "Metadados do descritor indisponíveis.",
			cap_effect_read_external: "Leitura externa",
			cap_effect_write_external: "Escrita externa",
			cap_effect_inference: "Inferência",
			cap_effect_produce_artifact: "Produzir artefato",
			cap_effect_execute_local: "Executar localmente",
			cap_destination_public: "Pública: {id}",
			cap_destination_local: "Local: {id}",
			cap_destination_provider: "Provedor: {id}",
			cap_destination_unknown: "Destino: {id}",
			cap_limits: "{steps} etapas · {calls} chamadas · {tokens} tokens · {timeout}s",
			cap_results_count: "{count} capacidades encontradas",
			cap_results_sr: "Mostrando {count} capacidades",
			cx_accounts_title: "Contas e permissões",
			cx_connections_loading: "Carregando conexões…",
			cx_connections_failed: "Não foi possível carregar as conexões. Tente novamente.",
			cx_connections_retry: "Tentar novamente",
			cx_accounts_sub: "Um provedor, várias contas. As chaves ficam neste dispositivo.",
			cx_add_account: "Adicionar conta",
			cx_provider_id: "ID do provedor",
			cx_access_mode: "Modo de acesso",
			cx_get_access: "Obter acesso",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "Configurar",
			cx_label: "Nome",
			cx_secret: "Chave",
			cx_secret_hint: "Vazio cancela.",
			cx_endpoint: "Endpoint",
			cx_models: "Modelos (separados por vírgula)",
			cx_add: "Adicionar",
			cx_save: "Salvar",
			cx_test: "Testar",
			cx_test_all: "Testar todas",
			cx_test_inference: "Testar com chamadas ao provedor",
			cx_testing: "Testando…",
			cx_consent: "Permitir chamadas ao provedor com teto",
			cx_cap_usd: "Teto (USD)",
			cx_cancel: "Cancelar",
			cx_revoke: "Revogar",
			cx_confirm_revoke: "Clique de novo para confirmar",
			cx_reconnect: "Reconectar",
			cx_rename: "Renomear",
			cx_disable: "Desativar",
			cx_enable: "Ativar",
			cx_primary: "Tornar principal",
			cx_install: "Baixar",
			cx_model: "Modelo",
			cx_size_unknown: "Tamanho indisponível",
			cx_no_accounts: "Nenhuma conta ainda. Adicione a primeira para testar aqui.",
			cx_resume: "Retomar",
			cx_connect_oauth: "Conectar com {provider}",
			cx_error: "Erro: {type}",
			cx_job_state: "Job: {state}",
			cx_st_healthy: "Saudável",
			cx_st_degraded: "Degradada",
			cx_st_unauthenticated: "Sem chave",
			cx_st_disabled: "Desativada",
			cx_st_unconfigured: "Não configurada",
			cx_st_unknown: "Desconhecida",
			cx_st_expired: "Expirada",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "Não autorizada",
			cx_rs_rate_limited: "Limite excedido",
			cx_rs_timeout: "Tempo esgotado",
			cx_rs_unreachable: "Inalcançável",
			cx_rs_skipped: "Pulada",
			cx_rs_failed: "Falhou",
			cap_scope_required: "Requer permissões",
			cap_no_action_available: "Capacidade de referência: sem formulário de execução direta neste workspace",
			"recipe_R-DC-07_name": "Resumo de repositório GitHub",
			"recipe_R-DC-07_desc": "Lê um repositório público do GitHub e produz um documento markdown com suas fontes."
		},
		es: {
			ws_embeddings_title: "Embeddings",
			ws_embeddings_description: "Crea vectores con el modelo conectado.",
			ws_automation_schedule_authorize: "Autorizar programación",
			ws_automation_schedule_scope: "Permiso recurrente limitado por alcance, cantidad y vencimiento.",
			ws_automation_channel_resend: "Enviar con Resend",
			ws_automation_channel_brevo: "Enviar con Brevo",
			ws_automation_channel_slack: "Enviar con Slack",
			ws_automation_channel_description: "Envía el mensaje revisado después de autorizarlo.",
			classification_semantic_title: "Clasificar con TypeSafe",
			classification_semantic_note: "Analiza solo el texto seleccionado; el resultado no autoriza acciones.",
			df_model_plugin: "Referencia del plugin de modelo",
			df_plugin_version: "Versión referenciada",
			df_plugin_hash: "SHA-256 declarado",
			df_plugin_note: "Referencia declarada en la plantilla. No se instala ningún paquete de plugin ni se verifica ningún hash de paquete.",
			df_temperature: "Temperatura",
			df_top_p: "Top-p",
			df_title: "Importar plantilla Dify",
			df_profile: "Perfil compatible: inicio → LLM → fin con una entrada de texto. Las herramientas, el código, RAG, las variables de entorno y los plugins de herramientas quedan fuera de este perfil. Las referencias de plugins de modelo se pueden leer sin instalarlos.",
			df_file: "Archivo YAML local",
			df_file_help: "Hasta {bytes} bytes. Lectura local; el YAML no se guarda.",
			df_source_model: "Modelo de la plantilla",
			df_target_model: "Modelo configurado para este plan",
			df_mapping: "El modelo original se muestra como referencia. Los mensajes materializados usan solo el modelo configurado en el gateway, tras la aprobación.",
			df_template: "Plantilla",
			df_max_tokens: "Máximo de tokens de salida",
			df_prepare: "Preparar plan",
			df_prepare_note: "Solo se usan los mensajes materializados de la plantilla. Se excluyen el historial previo, los archivos adjuntos, las fuentes de investigación y el borrador actual. La ejecución requiere una aprobación separada.",
			df_file_error: "Elige un archivo .yaml o .yml no vacío de hasta {bytes} bytes. No se aceptan archivos de entorno.",
			df_invalid: "Plantilla rechazada. Usa el perfil inicio → LLM → fin sin funciones ni ajustes no compatibles.",
			df_limit: "El archivo o la estructura YAML supera los límites admitidos.",
			df_input_error: "Introduce el texto obligatorio con un máximo de {max} caracteres y un límite de salida de 1 a 4096.",
			df_payload_error: "La plantilla materializada supera el límite de 12.000 bytes del chat. Acorta el texto o la entrada.",
			df_read_error: "No se pudo leer el archivo seleccionado.",
			mu_title: "Modelos y cuotas",
			mu_refresh: "Actualizar",
			mu_no_models: "No hay datos de modelos configurados.",
			mu_provider_scope: "Cuota local compartida por los modelos configurados de este proveedor.",
			mu_quota_unknown: "Contabilidad de cuota no disponible.",
			mu_table_note: "Reservas / límites locales configurados",
			mu_window: "Período",
			mu_reserved_calls: "Llamadas reservadas",
			mu_reserved_tokens: "Tokens reservados",
			mu_minute: "Minuto actual",
			mu_day: "Día actual",
			mu_reservation_note: "Las reservas de tokens incluyen la entrada estimada y la salida máxima permitida. No representan consumo medido.",
			mu_presented_run: "Ejecución presentada",
			mu_usage_unknown: "Consumo medido no disponible.",
			mu_input_tokens: "Tokens de entrada informados",
			mu_output_tokens: "Tokens de salida informados",
			mu_receipt_coverage: "Intentos con consumo completo informado / intentos de esta ejecución",
			mu_subset_note: "Las cifras incluyen solo mediciones informadas. Las mediciones ausentes siguen siendo desconocidas; estas cifras no representan todo el consumo.",
			mu_router_usage: "Llamadas directas del proxy",
			mu_router_scope: "Respuestas directas satisfactorias del Router desde el inicio de este proceso. Este contador excluye las llamadas del gateway del workspace y no se conserva.",
			mu_with_usage: "Respuestas con consumo informado",
			mu_without_usage: "Respuestas sin consumo informado",
			mu_in_flight: "Respuestas en curso",
			mu_interrupted: "Respuestas interrumpidas",
			bm_title: "Comparación de modelos",
			bm_back: "Volver",
			bm_start_explicit: "Ejecutar probe activo",
			bm_no_autorun_note: "Abrir este panel no inicia un benchmark. Los probes activos requieren inicio explícito.",
			bm_filter: "Filtrar modelos",
			bm_filter_placeholder: "Filtrar por modelo o proveedor",
			bm_empty: "Aún no hay ranking. Cargue o ejecute un probe para comparar.",
			bm_metric: "Métrica",
			bm_method: "Método",
			bm_cohort: "Cohorte",
			bm_n: "n",
			bm_source_date: "Fecha de origen",
			bm_table_caption: "Tabla de comparación",
			bm_model: "Modelo",
			bm_score: "Puntuación",
			bm_source: "Fuente",
			bm_tools: "Herramientas",
			bm_tools_yes: "Sí",
			bm_tools_no: "No",
			bm_exclusions: "Exclusiones",
			bm_observations: "Observaciones",
			bm_stale: "Obsoleto",
			ws_gateway_preview_truncated: "Vista previa truncada. La respuesta completa estará en el archivo final cuando la ejecución termine correctamente.",
			ws_gateway_reconnect: "Vuelve a conectar para consultar el estado de este trabajo.",
			ws_gateway_payload: "Mensajes que se enviarán",
			ws_gateway_text_only: "Solo texto: elimina adjuntos y selecciona ninguna fuente de investigación.",
			ws_gateway_size: "La conversación completa debe caber en 12.000 bytes. Inicia otro chat o acorta el texto.",
			ws_gateway_title: "Conversación",
			ws_gateway_description: "Envía los mensajes mostrados una sola vez, tras la aprobación.",
			ws_browser_title: "Inspección de una página local",
			ws_speech_playback_error: "No se pudo reproducir este audio. La generación no se repetirá automáticamente.",
			ws_image_prepare: "Preparar imágenes",
			ws_video_title: "Vídeo",
			ws_video_limits_value: "{calls} llamadas · {seconds}s en total",
			ws_video_description: "Revisa antes de enviar. Las opciones dependen del modelo configurado.",
			ws_video_duration: "Duración (segundos)",
			ws_video_ratio: "Relación de aspecto",
			ws_video_resolution: "Resolución",
			ws_video_audio: "Generar audio",
			ws_video_seed: "Semilla (opcional)",
			ws_video_prepare: "Revisar solicitud de vídeo",
			ws_video_invalid: "Comprueba las opciones del vídeo o vuelve a conectar.",
			ws_video_download: "Descargar MP4",
			ws_video_load: "Cargar vídeo",
			ws_video_stop_notice: "Detener el seguimiento no cancela la generación en el proveedor.",
			ws_video_resume: "Reanudar seguimiento",
			ws_video_status_pending: "En la cola del proveedor",
			ws_video_status_in_progress: "Generando en el proveedor",
			ws_video_status_completed: "Generación completada en el proveedor",
			ws_video_status_failed: "La generación falló en el proveedor",
			ws_video_status_cancelled: "Cancelado por el proveedor",
			ws_video_status_expired: "Caducado en el proveedor",
			ws_video_poll_title: "Seguir vídeo",
			ws_video_poll_description: "Consultar el trabajo conocido sin crear otro vídeo.",
			ws_video_content_title: "Obtener vídeo",
			ws_video_content_description: "Descargar el resultado terminado al espacio de trabajo.",
			ws_image_title: "Imágenes",
			ws_image_description: "Prepare un plan; las imágenes se generan solo tras autorización. El soporte depende del proveedor.",
			ws_image_prompt: "Descripción",
			ws_image_count: "Cantidad de imágenes",
			ws_image_size: "Tamaño (auto o AxA)",
			ws_image_quality: "Calidad (opcional)",
			ws_image_style: "Estilo (opcional)",
			ws_image_load: "Cargar imagen",
			ws_image_invalid: "No se pudo preparar o cargar la imagen. Revise la solicitud y la conexión.",
			ws_image_download: "Descargar imagen",
			ws_speech_title: "Generar voz",
			ws_speech_description: "Tras la aprobación, convierte únicamente el texto introducido en audio con el modelo mostrado.",
			ws_speech_input: "Texto para pronunciar",
			ws_speech_prepare: "Preparar plan de voz",
			ws_speech_invalid: "Introduce texto dentro del límite local de 12.000 bytes UTF-8.",
			ws_speech_result: "Audio generado",
			ws_speech_result_note: "Audio generado por IA. La reproducción comienza solo cuando lo elijas.",
			ws_speech_load: "Cargar audio",
			ws_speech_loading: "Cargando audio…",
			ws_speech_audio_error: "No se pudo cargar y verificar el audio. Intenta cargarlo de nuevo.",
			ws_speech_limits_value: "{calls} generaciones · {seconds}s",
			ws_transcription_title: "Transcribir audio",
			ws_transcription_description: "Tras la aprobación, transcribe el audio seleccionado en texto revisable con el modelo mostrado.",
			ws_transcription_file: "Archivo de audio (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "Idioma (opcional, ISO 639-1)",
			ws_transcription_prepare: "Preparar plan de transcripción",
			ws_transcription_invalid: "Elige un archivo MP3 y usa un código de idioma de dos letras, o déjalo en blanco.",
			ws_transcription_result: "Transcripción",
			ws_browser_fill_title: "Rellenar campos de la página local",
			ws_browser_fill_description: "Tras la aprobación, rellena los campos indicados y captura la página. El formulario no se envía y no se confirma que se guarde en el servidor.",
			ws_browser_fill_field: "Campo {number}",
			ws_browser_fill_label: "Etiqueta exacta del campo",
			ws_browser_fill_value: "Valor",
			ws_browser_fill_empty: "Un valor vacío borra el campo.",
			ws_browser_fill_add: "Añadir campo",
			ws_browser_fill_prepare: "Preparar para revisión",
			ws_browser_fill_invalid: "Usa una URL de {origin} y entre 1 y 8 etiquetas distintas (hasta 200 caracteres). Cada valor admite 2.000 caracteres; acórtalos si la solicitud completa es demasiado grande.",
			ws_browser_fill_local: "Solo {origin}. Los scripts de la página están desactivados.",
			ws_browser_fill_limits_value: "{steps} pasos · {calls} acciones · {seconds}s",
			ws_browser_description: "Inspecciona una página local tras la aprobación, sin hacer clic ni interactuar con formularios.",
			ws_tools_result_prepare: "Preparar una respuesta con este resultado",
			project_changeset_title: "Cambios de archivo propuestos",
			project_changeset_note: "El modelo propuso estos cambios. No se escribe nada hasta que apruebes el plan; el daemon verifica los hashes antes de escribir.",
			project_apply: "Revisar y aplicar",
			project_apply_busy: "Preparando…",
			project_apply_started: "Plan aprobado. Se inició la ejecución de escritura; reabre el espacio de trabajo para ver el resultado.",
			project_apply_bind_first: "Vincula la carpeta mediante el proxy local antes de aplicar cambios.",
			project_apply_unavailable: "Aplicar cambios no está disponible en esta sesión.",
			ws_tools_result_consent: "Este resultado se enviará al modelo solo después de aprobar el nuevo plan.",
			ws_tools_enable: "Sugerir acciones locales en el chat",
			ws_tools_description: "Las herramientas seleccionadas permiten proponer acciones. Cada acción requiere un plan separado y su aprobación.",
			ws_tools_proposal: "Propuesta de acción",
			ws_tools_not_executed: "Este mensaje es una propuesta. Preparar una acción no la ejecuta; apruebe el nuevo plan para ejecutarla.",
			ws_tools_prepare: "Preparar esta acción",
			ws_filesystem_title: "Metadatos de archivos locales",
			ws_filesystem_tool: "Herramienta",
			ws_filesystem_path: "Ruta relativa",
			ws_filesystem_list: "Listar directorio",
			ws_filesystem_info: "Información del archivo",
			ws_filesystem_description: "Solo nombres y metadatos en la carpeta configurada. Sin contenido ni cambios de archivos.",
			ws_filesystem_unavailable: "Herramientas de archivos locales no disponibles.",
			ws_filesystem_invalid: "Compruebe la ruta o vuelva a conectar para actualizar las herramientas y prepare un nuevo plan.",
			ws_browser_open: "Inspeccionar página local",
			ws_composition_open: "Siguiente paso condicional",
			ws_composition_description: "Comprueba un texto literal, distinguiendo mayúsculas, en el resultado local seleccionado. Una coincidencia solo propone otra inspección, que requiere una nueva aprobación.",
			ws_composition_contains: "Si el resultado contiene",
			ws_composition_next: "Proponer inspección de esta URL",
			ws_composition_check: "Comprobar condición",
			ws_composition_no_match: "No se encontró el texto. No se creó otro plan.",
			ws_composition_ready: "La condición se cumplió. Revisa el siguiente plan antes de aprobarlo.",
			ws_composition_review: "Esta composición requiere revisión. No se ejecutó otro paso.",
			ws_composition_review_plan: "Revisar siguiente plan",
			ws_browser_url: "URL de la página local",
			ws_browser_prepare: "Preparar inspección",
			ws_browser_invalid: "Introduce una URL completa del origen {origin}. La inspección comienza solo tras la aprobación.",
			ws_browser_limits_value: "{steps} pasos · {calls} inspecciones · {seconds}s",
			ws_download_requested: "Descarga solicitada de {name}. Revisa las descargas del navegador.",
			title: "Tu IA. Fuentes reales.",
			connect: "Conectar",
			disconnect: "Desconectar",
			connected: "Conectado",
			offline: "Offline",
			connecting: "Conectando…",
			send: "Enviar",
			stop: "Detener",
			placeholder: "Pregunta… Usa @ para modelos o fuentes de investigación.",
			hint: "Ctrl+Enter envía · Esc detiene · @ menciones · adjuntos ok",
			model: "Modelo",
			sources: "Investigación",
			newChat: "Nueva conversación",
			empty_title: "Tu IA. Fuentes reales.",
			empty_body: "Conecta al proxy local (127.0.0.1:21435), elige un modelo local o BYOK, opcionalmente @pubmed / @crossref / @open-library, y pregunta. Las claves quedan en este dispositivo.",
			you: "Tú",
			ai: "IA",
			searching: "Buscando referencias…",
			answering: "Pensando…",
			queryLabel: "Términos de búsqueda",
			queryHint: "Mínimo 2 caracteres para investigación",
			local: "Local",
			cloud: "Cloud BYOK",
			research: "Investigación",
			connections: "Conexiones",
			history: "Historial",
			theme: "Tema",
			theme_dark: "Oscuro",
			theme_light: "Claro",
			theme_auto: "Auto",
			keys_local: "Las claves quedan en el dispositivo",
			attach: "Adjuntar archivos",
			remove: "Quitar",
			stop_kept: "Detenido — respuesta parcial conservada",
			unknown: "desconocido",
			cost_unknown: "coste: desconocido",
			fallback_on: "fallback autorizado",
			disabled_zai: "solo investigación / bloqueado en el proxy",
			disabled_openalex: "no admitido en el proxy",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "offline",
			runtime_ok: "alcanzable",
			no_local_models: "Aún no hay modelos locales descubiertos.",
			no_history: "Sin chats guardados. Empieza uno — queda en este navegador.",
			attach_busy: "Leyendo archivo…",
			err_provision: "No se pudo aprovisionar — ¿proxy en 127.0.0.1:21435?",
			err_request: "Error en la solicitud",
			err_source: "Error al buscar fuentes",
			err_source_rate: "Límite de fuentes — reintenta pronto",
			err_capacity: "Capacidad local ocupada — reintenta",
			err_invalid: "Solicitud inválida",
			menu: "Abrir menú",
			close_menu: "Cerrar menú",
			lang: "Idioma",
			credits: "Créditos",
			size_est: "tam. est.",
			aliases: "Aliases locales",
			discovered: "Modelos instalados",
			none_source: "Solo IA",
			papers: "papers",
			books: "libros",
			delete_chat: "Eliminar",
			composer_disabled: "Conecta al proxy para chatear",
			connect_first: "Conecta al proxy para enviar",
			more_options: "Más opciones",
			hide_options: "Ocultar opciones",
			new_project: "Nuevo proyecto",
			projects: "Proyectos",
			project_name: "Nombre del proyecto",
			local_storage: "Almacenado localmente",
			streaming: "Transmitiendo…",
			mic: "Dictar",
			mic_stop: "Detener dictado",
			mic_listening: "Escuchando…",
			mic_unsupported: "Dictado no admitido en este navegador",
			mic_denied: "Permiso de micrófono denegado",
			mic_error: "Falló el dictado",
			sidebar: "Barra lateral",
			note_text_read_failed: "No se pudo leer el archivo de texto — solo el nombre.",
			note_pdf_empty: "El PDF no tiene texto extraíble (solo el nombre).",
			note_pdf_unavailable: "Extracción de texto del PDF no disponible — adjuntado solo por el nombre.",
			note_doc_binary: "Lectura no compatible — solo el nombre (.doc binario).",
			note_doc_unsupported: "Lectura no compatible — solo el nombre (docx).",
			note_doc_compressed: "Lectura no compatible — solo el nombre (docx comprimido).",
			note_doc_besteffort: "Texto del docx extraído de forma aproximada (puede estar incompleto).",
			note_unsupported_parse: "Lectura no compatible — solo el nombre.",
			note_image_attached: "Imagen adjunta ({name}, {size} bytes). Se envía al modelo solo si probablemente admite imágenes; si no, queda solo como vista previa local.",
			note_image_preview_failed: "Imagen adjunta ({name}) — falló la vista previa.",
			note_audio_attached: "Audio adjunto ({name}, {size} bytes) — este cliente no transcribe audio; solo se comparte nombre y tamaño.",
			note_unsupported_type: "Tipo de archivo no compatible — solo el nombre ({name}).",
			hint_prefer_local: "Prefiere runtime local",
			hint_local_gemma: "Modelo Gemma local",
			hint_local_qwen: "Modelo Qwen local",
			hint_auto_route: "Enrutamiento automático",
			hint_same_as_auto: "Igual a uptokey-auto",
			hint_pubmed: "Artículos de PubMed",
			hint_crossref: "DOIs de Crossref",
			hint_open_library: "Libros de Open Library",
			hint_local_model: "Modelo local",
			ws_title: "Trabajo de investigación",
			ws_open: "Investigar y crear informe",
			ws_hide: "Ocultar panel del trabajo",
			ws_unavailable: "La ejecución del espacio de trabajo aún no está conectada. El plan, los pasos, las evidencias y la exportación aparecen aquí cuando el espacio de trabajo local esté disponible.",
			ws_contract_mismatch: "Este trabajo usa una versión de contrato distinta a la de esta interfaz. Los valores pueden estar incompletos.",
			ws_goal: "¿Qué debe hacer este trabajo?",
			ws_goal_placeholder: "p. ej.: Revisiones recientes sobre vitamina D e inmunidad",
			ws_create: "Crear trabajo",
			ws_update: "Actualizar trabajo",
			ws_save_recipe: "Guardar rutina",
			ws_recipe_saved: "Rutina guardada",
			ws_recipe_note: "Una rutina guarda parámetros y pasos. No lleva claves ni permisos y no autoriza la ejecución por sí sola.",
			ws_plan: "Plan",
			ws_plan_sources: "Fuentes",
			ws_plan_destination: "Destino de los datos",
			ws_plan_model: "Modelo",
			ws_plan_limits: "Límites",
			ws_approve: "Autorizar y ejecutar",
			ws_approval_note: "La autorización está vinculada a este plan. Un cambio material exige una nueva autorización.",
			ws_state_draft: "Borrador",
			ws_state_awaiting_approval: "Esperando autorización",
			ws_state_ready: "Listo",
			ws_state_running: "Ejecutando",
			ws_state_succeeded: "Completado",
			ws_state_failed: "Falló",
			ws_state_cancelled: "Interrumpido",
			ws_state_needs_attention: "Requiere atención",
			ws_steps: "Pasos",
			ws_step_prepared: "Preparado",
			ws_step_dispatched: "Enviado",
			ws_step_succeeded: "Hecho",
			ws_step_failed: "Falló",
			ws_step_unknown: "Resultado desconocido",
			ws_step_unknown_note: "Enviado sin resultado confirmado. No se repite automáticamente.",
			ws_step_account_note: "No enviado: la cuenta vinculada no tiene saldo observado vigente, saldo suficiente ni precio por unidad conocido. Revísela en Cuentas.",
			ws_cancel: "Interrumpir",
			api_field_pokemon_name: "Nombre del Pokémon",
			api_field_owner: "Propietario",
			api_field_repo: "Repositorio",
			api_field_state: "Estado",
			api_field_page: "Página",
			api_field_per_page: "Por página",
			api_field_indicator: "Indicador",
			api_field_format: "Formato",
			api_op_get_public_repository_issues: "Obtener incidencias del repositorio público",
			api_op_get_public_repository_pulls: "Obtener pull requests del repositorio público",
			api_op_get_pokemon: "Obtener Pokémon",
			api_op_get_country_indicator: "Obtener indicador de país",
			api_op_get_apod: "Imagen astronómica del día",
			repoUrl: "URL del repositorio",
			recipe_param_repoUrl: "URL del repositorio",
			ws_cancelled_note: "Interrumpido. Se muestra el último estado guardado.",
			ws_evidence: "Evidencias consultadas",
			ws_evidence_consulted: "consultada el {date}",
			ws_evidence_not_retrieved: "no recuperada",
			ws_evidence_empty: "Ninguna fuente consultada todavía.",
			ws_result: "Resultado",
			ws_delete_confirm: "¿Eliminar permanentemente este proyecto, sus informes e historial? Se conservan los archivos exportados y los originales importados.",
			ws_import: "Importar contexto seleccionado",
			ws_context: "Contexto para esta ejecución",
			project_choose_folder: "Elegir una carpeta (opcional)",
			ws_import_note: "Seleccione mensajes o textos guardados de archivos adjuntos para copiarlos localmente. Si falta el texto, adjunte el archivo de nuevo. Se conservan los originales. Reimportar abre la copia existente. No se ejecuta nada.",
			ws_constraints: "Restricciones (una por línea)",
			ws_compare: "Comparar con el informe anterior (− eliminado, + añadido)",
			ws_result_open: "Abrir",
			ws_persisted_note: "Guardado en el espacio de trabajo local. Eso no es un archivo exportado.",
			ws_export_folder: "Guardar en la carpeta del proyecto",
			ws_export_download: "Descargar",
			ws_export_done: "Exportado como {name}",
			ws_export_failed: "Falló la exportación. El informe sigue guardado en el espacio de trabajo.",
			ws_export_overwrite: "¿Sobrescribir {name} en la carpeta del proyecto?",
			ws_export_no_folder: "No hay carpeta de proyecto concedida en este navegador. Puede que haya que volver a concederla tras reabrir.",
			ws_usage_title: "Tu uso este mes",
			ws_usage_charged: "Cobrado por Uptokey",
			ws_usage_reference: "Valor de referencia del uso",
			ws_usage_reference_note: "Estimación con tarifas públicas de referencia. No es una factura ni un ahorro confirmado.",
			ws_usage_coverage: "Cobertura de la medición",
			ws_usage_coverage_value: "{included} de {observed} llamadas",
			ws_usage_details: "Comprobar el cálculo",
			ws_usage_basis_provider: "reportado por el proveedor",
			ws_usage_basis_estimated: "estimado",
			ws_usage_basis_unknown: "base desconocida",
			ws_usage_cov_included: "incluida",
			ws_usage_cov_missing_usage: "sin uso reportado",
			ws_usage_cov_missing_tariff: "sin tarifa",
			ws_usage_cov_not_comparable: "no comparable",
			ws_usage_cov_estimated: "uso estimado",
			ws_usage_cov_local_cache: "reutilizada localmente",
			ws_usage_access_public: "acceso público",
			ws_usage_access_byok: "tu propia clave",
			ws_usage_access_local: "ejecución local",
			ws_usage_access_hosted: "acceso alojado",
			ws_usage_charge_unconfirmed: "No todas las llamadas de este periodo confirmaron un cobro, así que el total queda desconocido en vez de cero.",
			ws_usage_no_aggregable: "Ninguna llamada tuvo a la vez uso reportado y una tarifa correspondiente.",
			ws_usage_cached: "{cached} en caché",
			ws_usage_rate: "{input}/M entrada · {output}/M salida",
			ws_usage_reused: "respuesta reutilizada",
			ws_usage_tariff: "tarifa {id} · {checkedAt}",
			ws_usage_byok_note: "Cobrado por Uptokey no es el coste total: BYOK puede cobrarlo directamente el proveedor y un modelo local consume tu propio equipo y energía.",
			ws_usage_units: "{input} entrada · {output} salida",
			ws_usage_empty: "Ninguna llamada medida en este periodo.",
			ws_step_pending: "Pendiente",
			ws_plan_limits_value: "{steps} pasos · {calls} llamadas · {tokens} salida · {seconds}s",
			ws_capability_unavailable: "no ejecutable",
			ws_evidence_note: "La instantánea registra lo que se leyó en ese momento; eso no hace que el contenido sea verdadero.",
			"workflow.sources.crossref.search.title": "Buscar en Crossref",
			"workflow.sources.crossref.search.description": "Busca artículos y DOIs en el catálogo público de Crossref.",
			"workflow.sources.open-library.search.title": "Buscar en Open Library",
			"workflow.sources.open-library.search.description": "Busca libros y autores en el catálogo público de Open Library.",
			"workflow.sources.pubmed.search.title": "Buscar en PubMed",
			"workflow.sources.pubmed.search.description": "Busca literatura biomédica en PubMed.",
			"workflow.sources.openalex.search.title": "Buscar en OpenAlex",
			"workflow.sources.openalex.search.description": "Busca trabajos académicos en el catálogo público de OpenAlex.",
			"workflow.sources.archive.search.title": "Buscar en archivos históricos",
			"workflow.sources.archive.search.description": "Busca registros históricos en la fuente de archivo.",
			"workflow.sources.rss.read.title": "Leer feed RSS",
			"workflow.sources.rss.read.description": "Obtiene entradas de un feed RSS o Atom público.",
			"workflow.capabilities.project_write.title": "Escribir archivos del proyecto",
			"workflow.capabilities.project_write.description": "Crea o edita archivos dentro de la carpeta autorizada del proyecto.",
			chat_edit: "Editar",
			chat_regenerate: "Regenerar",
			chat_save_submit: "Guardar y enviar",
			chat_cancel_edit: "Cancelar",
			cap_discovery_title: "Descubrimiento de capacidades",
			cap_discovery_search_placeholder: "Buscar capacidades por nombre, etiqueta o destino...",
			cap_filter_all: "Todas",
			cap_filter_available: "Disponibles",
			cap_filter_configurable: "Configurables",
			cap_filter_unavailable: "No disponibles",
			cap_tier_available: "Disponible",
			cap_tier_configurable: "Configurable",
			cap_tier_unavailable: "No disponible",
			cap_action_open_form: "Abrir formulario",
			cap_action_prepare: "Preparar plan",
			cap_action_configure: "Configurar",
			cap_action_unavailable: "No disponible",
			cap_action_details: "Detalles",
			cap_action_hide_details: "Ocultar detalles",
			cap_action_clear_search: "Borrar búsqueda",
			cap_filter_group_label: "Filtrar capacidades por disponibilidad",
			cap_label_destination: "Destino",
			cap_label_effect: "Efecto",
			cap_label_limits: "Límites de ejecución",
			cap_label_tags: "Etiquetas",
			cap_label_schemas: "Esquemas de entrada/salida",
			cap_label_retry_class: "Política de reintento",
			cap_empty_title: "No se encontraron capacidades",
			cap_empty_desc: "Ninguna capacidad coincide con la búsqueda o filtros actuales.",
			cap_empty_unregistered: "Aún no se han registrado capacidades en este espacio de trabajo.",
			cap_reason_executable: "Lista para preparar el plan de ejecución",
			cap_reason_catalogued: "Catalogada: requiere configuración adicional",
			cap_reason_missing_scopes: "Requiere permisos: {scopes}",
			cap_reason_scopes_unknown: "Permisos no confirmados; requiere: {scopes}",
			cap_reason_unavailable: "No ejecutable en este entorno",
			cap_reason_incompatible_schema: "Metadatos de la capacidad incompatibles o incompletos",
			cap_reason_unknown: "Metadatos del descriptor incompletos o no reconocidos",
			cap_unknown_title: "Capacidad: {id}",
			cap_unknown_desc: "Metadatos del descriptor no disponibles.",
			cap_effect_read_external: "Lectura externa",
			cap_effect_write_external: "Escritura externa",
			cap_effect_inference: "Inferencia",
			cap_effect_produce_artifact: "Producir artefacto",
			cap_effect_execute_local: "Ejecutar localmente",
			cap_destination_public: "Pública: {id}",
			cap_destination_local: "Local: {id}",
			cap_destination_provider: "Proveedor: {id}",
			cap_destination_unknown: "Destino: {id}",
			cap_limits: "{steps} pasos · {calls} llamadas · {tokens} tokens · {timeout}s",
			cap_results_count: "{count} capacidades encontradas",
			cap_results_sr: "Mostrando {count} capacidades",
			cx_accounts_title: "Cuentas y permisos",
			cx_connections_loading: "Cargando conexiones…",
			cx_connections_failed: "No se pudieron cargar las conexiones. Inténtalo de nuevo.",
			cx_connections_retry: "Reintentar",
			cx_accounts_sub: "Un proveedor, varias cuentas. Las claves quedan en este dispositivo.",
			cx_add_account: "Añadir cuenta",
			cx_provider_id: "ID del proveedor",
			cx_access_mode: "Modo de acceso",
			cx_get_access: "Obtener acceso",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "Configurar",
			cx_label: "Nombre",
			cx_secret: "Clave",
			cx_secret_hint: "Vacío cancela.",
			cx_endpoint: "Endpoint",
			cx_models: "Modelos (separados por comas)",
			cx_add: "Añadir",
			cx_save: "Guardar",
			cx_test: "Probar",
			cx_test_all: "Probar todas",
			cx_test_inference: "Probar con llamadas al proveedor",
			cx_testing: "Probando…",
			cx_consent: "Permitir llamadas al proveedor con tope",
			cx_cap_usd: "Tope (USD)",
			cx_cancel: "Cancelar",
			cx_revoke: "Revocar",
			cx_confirm_revoke: "Pulse de nuevo para confirmar",
			cx_reconnect: "Reconectar",
			cx_rename: "Renombrar",
			cx_disable: "Desactivar",
			cx_enable: "Activar",
			cx_primary: "Hacer principal",
			cx_install: "Descargar",
			cx_model: "Modelo",
			cx_size_unknown: "Tamaño no disponible",
			cx_no_accounts: "Aún no hay cuentas. Añada la primera para probarla aquí.",
			cx_resume: "Reanudar",
			cx_connect_oauth: "Conectar con {provider}",
			cx_error: "Error: {type}",
			cx_job_state: "Tarea: {state}",
			cx_st_healthy: "Saludable",
			cx_st_degraded: "Degradada",
			cx_st_unauthenticated: "Sin clave",
			cx_st_disabled: "Desactivada",
			cx_st_unconfigured: "No configurada",
			cx_st_unknown: "Desconocida",
			cx_st_expired: "Expirada",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "No autorizada",
			cx_rs_rate_limited: "Límite excedido",
			cx_rs_timeout: "Tiempo agotado",
			cx_rs_unreachable: "Inalcanzable",
			cx_rs_skipped: "Omitida",
			cx_rs_failed: "Falló",
			cap_scope_required: "Requiere permisos",
			cap_no_action_available: "Capacidad de referencia: sin formulario de ejecución directa en este espacio de trabajo",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		fr: {
			ws_embeddings_title: "Embeddings",
			ws_embeddings_description: "Créez des vecteurs avec le modèle connecté.",
			ws_automation_schedule_authorize: "Autoriser la programmation",
			ws_automation_schedule_scope: "Autorisation récurrente limitée par le périmètre, le nombre et la date d’expiration.",
			ws_automation_channel_resend: "Envoyer avec Resend",
			ws_automation_channel_brevo: "Envoyer avec Brevo",
			ws_automation_channel_slack: "Envoyer avec Slack",
			ws_automation_channel_description: "Envoyez le message vérifié après autorisation.",
			classification_semantic_title: "Classer avec TypeSafe",
			classification_semantic_note: "Analyser uniquement le texte sélectionné ; le résultat n’autorise aucune action.",
			df_model_plugin: "Référence du plugin de modèle",
			df_plugin_version: "Version référencée",
			df_plugin_hash: "SHA-256 déclaré",
			df_plugin_note: "Référence déclarée dans le template. Aucun paquet de plugin n’est installé et aucune empreinte de paquet n’est vérifiée.",
			df_temperature: "Température",
			df_top_p: "Top-p",
			df_title: "Importer un modèle Dify",
			df_profile: "Profil pris en charge : début → LLM → fin avec une entrée texte. Les outils, le code, le RAG, les variables d’environnement et les plugins d’outils sont exclus de ce profil. Les références de plugins de modèle peuvent être lues sans installation.",
			df_file: "Fichier YAML local",
			df_file_help: "Jusqu’à {bytes} octets. Lecture locale ; le YAML n’est pas enregistré.",
			df_source_model: "Modèle dans le template",
			df_target_model: "Modèle configuré pour ce plan",
			df_mapping: "Le modèle d’origine est affiché à titre de référence. Les messages matérialisés utilisent uniquement le modèle configuré dans le gateway, après approbation.",
			df_template: "Template",
			df_max_tokens: "Nombre maximal de tokens de sortie",
			df_prepare: "Préparer le plan",
			df_prepare_note: "Seuls les messages matérialisés du template sont utilisés. L’historique précédent, les pièces jointes, les sources de recherche et le brouillon actuel sont exclus. L’exécution exige une approbation séparée.",
			df_file_error: "Choisissez un fichier .yaml ou .yml non vide de {bytes} octets maximum. Les fichiers d’environnement ne sont pas acceptés.",
			df_invalid: "Template rejeté. Utilisez le profil début → LLM → fin sans fonctions ni paramètres non pris en charge.",
			df_limit: "Le fichier ou la structure YAML dépasse les limites prises en charge.",
			df_input_error: "Saisissez le texte requis, limité à {max} caractères, et une limite de sortie de 1 à 4096.",
			df_payload_error: "Le template matérialisé dépasse la limite de 12 000 octets du chat. Raccourcissez le texte ou l’entrée.",
			df_read_error: "Impossible de lire le fichier sélectionné.",
			mu_title: "Modèles et quotas",
			mu_refresh: "Actualiser",
			mu_no_models: "Aucune donnée de modèle configuré.",
			mu_provider_scope: "Quota local partagé par les modèles configurés de ce fournisseur.",
			mu_quota_unknown: "Comptabilisation du quota indisponible.",
			mu_table_note: "Réservations / limites locales configurées",
			mu_window: "Période",
			mu_reserved_calls: "Appels réservés",
			mu_reserved_tokens: "Tokens réservés",
			mu_minute: "Minute actuelle",
			mu_day: "Journée actuelle",
			mu_reservation_note: "Les réservations de tokens incluent l’entrée estimée et la sortie maximale autorisée. Elles ne représentent pas une consommation mesurée.",
			mu_presented_run: "Exécution affichée",
			mu_usage_unknown: "Consommation mesurée indisponible.",
			mu_input_tokens: "Tokens d’entrée déclarés",
			mu_output_tokens: "Tokens de sortie déclarés",
			mu_receipt_coverage: "Tentatives avec consommation complète déclarée / tentatives de cette exécution",
			mu_subset_note: "Les chiffres incluent uniquement les mesures déclarées. Les mesures absentes restent inconnues ; ces chiffres ne représentent pas toute la consommation.",
			mu_router_usage: "Appels directs du proxy",
			mu_router_scope: "Réponses directes réussies du Router depuis le démarrage de ce processus. Ce compteur exclut les appels du gateway du workspace et n’est pas conservé.",
			mu_with_usage: "Réponses avec consommation déclarée",
			mu_without_usage: "Réponses sans consommation déclarée",
			mu_in_flight: "Réponses en cours",
			mu_interrupted: "Réponses interrompues",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "Aperçu tronqué. La réponse complète sera disponible dans le résultat final après une exécution réussie.",
			ws_gateway_reconnect: "Reconnectez-vous pour consulter l’état de ce travail.",
			ws_gateway_payload: "Messages à envoyer",
			ws_gateway_text_only: "Texte uniquement : retirez les pièces jointes et ne sélectionnez aucune source de recherche.",
			ws_gateway_size: "La conversation complète doit tenir dans 12 000 octets. Ouvrez un autre chat ou raccourcissez le texte.",
			ws_gateway_title: "Conversation",
			ws_gateway_description: "Envoie les messages affichés une seule fois, après approbation.",
			ws_browser_title: "Inspection d’une page locale",
			ws_speech_playback_error: "Cet audio n’a pas pu être lu. La génération ne sera pas répétée automatiquement.",
			ws_image_prepare: "Préparer les images",
			ws_video_title: "Vidéo",
			ws_video_limits_value: "{calls} appels · {seconds}s au total",
			ws_video_description: "Vérifiez avant l’envoi. Les options dépendent du modèle configuré.",
			ws_video_duration: "Durée (secondes)",
			ws_video_ratio: "Format d’image",
			ws_video_resolution: "Résolution",
			ws_video_audio: "Générer le son",
			ws_video_seed: "Graine (facultatif)",
			ws_video_prepare: "Vérifier la demande vidéo",
			ws_video_invalid: "Vérifiez les options vidéo ou reconnectez-vous.",
			ws_video_download: "Télécharger le MP4",
			ws_video_load: "Charger la vidéo",
			ws_video_stop_notice: "Arrêter le suivi n’annule pas la génération chez le fournisseur.",
			ws_video_resume: "Reprendre le suivi",
			ws_video_status_pending: "En attente chez le fournisseur",
			ws_video_status_in_progress: "Génération chez le fournisseur",
			ws_video_status_completed: "Génération terminée chez le fournisseur",
			ws_video_status_failed: "Échec de génération chez le fournisseur",
			ws_video_status_cancelled: "Annulé par le fournisseur",
			ws_video_status_expired: "Expiré chez le fournisseur",
			ws_video_poll_title: "Suivre la vidéo",
			ws_video_poll_description: "Consulter la tâche connue sans créer une autre vidéo.",
			ws_video_content_title: "Récupérer la vidéo",
			ws_video_content_description: "Télécharger le résultat terminé dans votre espace de travail.",
			ws_image_title: "Images",
			ws_image_description: "Préparez un plan ; les images sont générées après autorisation. La prise en charge dépend du fournisseur.",
			ws_image_prompt: "Description",
			ws_image_count: "Nombre d’images",
			ws_image_size: "Taille (auto ou LxH)",
			ws_image_quality: "Qualité (facultative)",
			ws_image_style: "Style (facultatif)",
			ws_image_load: "Charger l’image",
			ws_image_invalid: "Impossible de préparer ou charger l’image. Vérifiez la demande et la connexion.",
			ws_image_download: "Télécharger l’image",
			ws_speech_title: "Générer une voix",
			ws_speech_description: "Après approbation, transforme uniquement le texte saisi ci-dessous en audio avec le modèle affiché.",
			ws_speech_input: "Texte à prononcer",
			ws_speech_prepare: "Préparer le plan vocal",
			ws_speech_invalid: "Saisissez un texte respectant la limite locale de 12 000 octets UTF-8.",
			ws_speech_result: "Audio généré",
			ws_speech_result_note: "Audio généré par IA. La lecture commence uniquement à votre demande.",
			ws_speech_load: "Charger l’audio",
			ws_speech_loading: "Chargement de l’audio…",
			ws_speech_audio_error: "Impossible de charger et de vérifier l’audio. Réessayez de le charger.",
			ws_speech_limits_value: "{calls} générations · {seconds}s",
			ws_transcription_title: "Transcrire l’audio",
			ws_transcription_description: "Après approbation, transcrivez l’audio sélectionné en texte relisible avec le modèle affiché.",
			ws_transcription_file: "Fichier audio (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "Langue (facultatif, ISO 639-1)",
			ws_transcription_prepare: "Préparer le plan de transcription",
			ws_transcription_invalid: "Choisissez un fichier MP3 et un code de langue à deux lettres, ou laissez vide.",
			ws_transcription_result: "Transcription",
			ws_browser_fill_title: "Remplir les champs de la page locale",
			ws_browser_fill_description: "Après approbation, remplit les champs affichés et capture la page. Le formulaire n’est pas envoyé et l’enregistrement sur le serveur n’est pas confirmé.",
			ws_browser_fill_field: "Champ {number}",
			ws_browser_fill_label: "Libellé exact du champ",
			ws_browser_fill_value: "Valeur",
			ws_browser_fill_empty: "Une valeur vide efface le champ.",
			ws_browser_fill_add: "Ajouter un champ",
			ws_browser_fill_prepare: "Préparer pour vérification",
			ws_browser_fill_invalid: "Utilisez une URL de {origin} et 1 à 8 libellés distincts (200 caractères maximum). Chaque valeur accepte 2 000 caractères ; raccourcissez les valeurs si la demande complète est trop volumineuse.",
			ws_browser_fill_local: "Uniquement {origin}. Les scripts de la page sont désactivés.",
			ws_browser_fill_limits_value: "{steps} étapes · {calls} actions · {seconds}s",
			ws_browser_description: "Inspecte une page locale après approbation, sans clics ni interaction avec les formulaires.",
			ws_tools_result_prepare: "Préparer une réponse avec ce résultat",
			project_changeset_title: "Modifications de fichiers proposées",
			project_changeset_note: "Le modèle a proposé ces modifications. Rien n'est écrit avant votre approbation du plan ; le daemon vérifie les hachages avant d'écrire.",
			project_apply: "Vérifier et appliquer",
			project_apply_busy: "Préparation…",
			project_apply_started: "Plan approuvé. L'exécution d'écriture a démarré ; rouvrez l'espace de travail pour voir le résultat.",
			project_apply_bind_first: "Associez le dossier via le proxy local avant d'appliquer des modifications.",
			project_apply_unavailable: "L'application des modifications n'est pas disponible dans cette session.",
			ws_tools_result_consent: "Ce résultat sera envoyé au modèle uniquement après votre approbation du nouveau plan.",
			ws_tools_enable: "Suggérer des actions locales dans le chat",
			ws_tools_description: "Les outils sélectionnés permettent de proposer des actions. Chaque action exige un plan distinct et votre approbation.",
			ws_tools_proposal: "Proposition d’action",
			ws_tools_not_executed: "Ce message est une proposition. Préparer une action ne l’exécute pas ; approuvez le nouveau plan pour l’exécuter.",
			ws_tools_prepare: "Préparer cette action",
			ws_filesystem_title: "Métadonnées des fichiers locaux",
			ws_filesystem_tool: "Outil",
			ws_filesystem_path: "Chemin relatif",
			ws_filesystem_list: "Lister le dossier",
			ws_filesystem_info: "Informations du fichier",
			ws_filesystem_description: "Uniquement les noms et métadonnées du dossier configuré. Aucun contenu ni modification de fichiers.",
			ws_filesystem_unavailable: "Outils de fichiers locaux indisponibles.",
			ws_filesystem_invalid: "Vérifiez le chemin ou reconnectez-vous pour actualiser les outils, puis préparez un nouveau plan.",
			ws_browser_open: "Inspecter une page locale",
			ws_composition_open: "Étape suivante conditionnelle",
			ws_composition_description: "Vérifiez un texte littéral sensible à la casse dans le résultat local sélectionné. Une correspondance propose uniquement une autre inspection, soumise à une nouvelle approbation.",
			ws_composition_contains: "Si le résultat contient",
			ws_composition_next: "Proposer une inspection de cette URL",
			ws_composition_check: "Vérifier la condition",
			ws_composition_no_match: "Le texte est absent. Aucun plan suivant créé.",
			ws_composition_ready: "La condition est remplie. Examinez le plan suivant avant approbation.",
			ws_composition_review: "Cette composition nécessite un examen. Aucune étape suivante exécutée.",
			ws_composition_review_plan: "Examiner le plan suivant",
			ws_browser_url: "URL de la page locale",
			ws_browser_prepare: "Préparer l’inspection",
			ws_browser_invalid: "Saisissez une URL complète de l’origine {origin}. L’inspection commence uniquement après approbation.",
			ws_browser_limits_value: "{steps} étapes · {calls} inspections · {seconds}s",
			ws_download_requested: "Téléchargement demandé pour {name}. Vérifiez les téléchargements du navigateur.",
			title: "Votre IA. Des sources réelles.",
			connect: "Connecter",
			disconnect: "Déconnecter",
			connected: "Connecté",
			offline: "Hors ligne",
			connecting: "Connexion…",
			send: "Envoyer",
			stop: "Arrêter",
			placeholder: "Posez votre question… Utilisez @ pour les modèles ou sources.",
			hint: "Ctrl+Entrée envoyer · Échap arrêter · micro dicter · @ mentions · pièces jointes",
			model: "Modèle",
			sources: "Recherche",
			newChat: "Nouvelle conversation",
			empty_title: "Votre IA. Des sources réelles.",
			empty_body: "Connectez-vous au proxy local (127.0.0.1:21435), choisissez un modèle local ou BYOK, utilisez éventuellement @pubmed / @crossref / @open-library, puis posez votre question. Vos clés restent sur cet appareil.",
			you: "Vous",
			ai: "IA",
			searching: "Recherche de références…",
			answering: "Réflexion…",
			queryLabel: "Termes de recherche",
			queryHint: "Au moins 2 caractères pour la recherche",
			local: "Local",
			cloud: "Cloud BYOK",
			research: "Recherche",
			connections: "Connexions",
			history: "Historique",
			theme: "Thème",
			theme_dark: "Sombre",
			theme_light: "Clair",
			theme_auto: "Auto",
			keys_local: "Les clés restent sur l’appareil",
			attach: "Joindre des fichiers",
			remove: "Supprimer",
			stop_kept: "Arrêté — réponse partielle conservée",
			unknown: "inconnu",
			cost_unknown: "coût : inconnu",
			fallback_on: "fallback autorisé",
			disabled_zai: "recherche uniquement / bloqué sur le proxy",
			disabled_openalex: "non admis sur le proxy",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "hors ligne",
			runtime_ok: "accessible",
			no_local_models: "Aucun modèle local détecté pour le moment.",
			no_history: "Aucune conversation enregistrée. Démarrez-en une — elle reste dans ce navigateur.",
			attach_busy: "Lecture du fichier…",
			err_provision: "Impossible de provisionner — le proxy est-il sur 127.0.0.1:21435 ?",
			err_request: "Échec de la requête",
			err_source: "Échec de la recherche de sources",
			err_source_rate: "Limite de débit de la source — réessayez bientôt",
			err_capacity: "Capacité locale occupée — réessayez",
			err_invalid: "Requête invalide",
			menu: "Ouvrir la barre latérale",
			close_menu: "Fermer la barre latérale",
			lang: "Langue",
			credits: "Crédits",
			size_est: "taille est.",
			aliases: "Alias locaux",
			discovered: "Modèles installés",
			none_source: "IA seule",
			papers: "articles",
			books: "livres",
			delete_chat: "Supprimer",
			composer_disabled: "Connectez le proxy pour discuter",
			connect_first: "Connectez le proxy pour envoyer",
			more_options: "Plus d’options",
			hide_options: "Moins d’options",
			new_project: "Nouveau projet",
			projects: "Projets",
			project_name: "Nom du projet",
			local_storage: "Stocké localement",
			streaming: "Diffusion en continu…",
			mic: "Dicter",
			mic_stop: "Arrêter la dictée",
			mic_listening: "Écoute en cours…",
			mic_unsupported: "Dictée non prise en charge dans ce navigateur",
			mic_denied: "Autorisation du microphone refusée",
			mic_error: "Échec de la dictée",
			sidebar: "Barre latérale",
			note_text_read_failed: "Impossible de lire le fichier texte — nom seul.",
			note_pdf_empty: "Le PDF ne contient aucun texte extractible (nom seul).",
			note_pdf_unavailable: "Extraction de texte PDF indisponible — joint par le nom uniquement.",
			note_doc_binary: "Lecture non prise en charge — nom seul (.doc binaire).",
			note_doc_unsupported: "Lecture non prise en charge — nom seul (docx).",
			note_doc_compressed: "Lecture non prise en charge — nom seul (docx compressé).",
			note_doc_besteffort: "Texte docx approximatif (peut être incomplet).",
			note_unsupported_parse: "Analyse non prise en charge — nom seul.",
			note_image_attached: "Image jointe ({name}, {size} octets). Envoyée au modèle seulement s’il gère les images ; sinon conservée en aperçu local.",
			note_image_preview_failed: "Image jointe ({name}) — échec de l’aperçu.",
			note_audio_attached: "Audio joint ({name}, {size} octets) — ce client ne transcrit pas l’audio ; seuls le nom et la taille sont transmis.",
			note_unsupported_type: "Type de fichier non pris en charge — nom seul ({name}).",
			hint_prefer_local: "Préférer le runtime local",
			hint_local_gemma: "Modèle local Gemma",
			hint_local_qwen: "Modèle local Qwen",
			hint_auto_route: "Routage automatique",
			hint_same_as_auto: "Identique à uptokey-auto",
			hint_pubmed: "Articles PubMed",
			hint_crossref: "DOI Crossref",
			hint_open_library: "Livres Open Library",
			hint_local_model: "Modèle local",
			ws_title: "Travail de recherche",
			ws_open: "Rechercher et créer un rapport",
			ws_hide: "Masquer le panneau du travail",
			ws_unavailable: "L'exécution de l'espace de travail n'est pas encore connectée. Le plan, les étapes, les preuves et l'export apparaissent ici dès que l'espace de travail local est disponible.",
			ws_contract_mismatch: "Ce travail utilise une version de contrat différente de celle de cette interface. Les valeurs peuvent être incomplètes.",
			ws_goal: "Que doit faire ce travail ?",
			ws_goal_placeholder: "ex. : Revues récentes sur la vitamine D et l’immunité",
			ws_create: "Créer le travail",
			ws_update: "Mettre à jour le travail",
			ws_save_recipe: "Enregistrer la routine",
			ws_recipe_saved: "Routine enregistrée",
			ws_recipe_note: "Une routine conserve des paramètres et des étapes. Elle ne contient ni clés ni autorisations et n'autorise pas l'exécution à elle seule.",
			ws_plan: "Plan",
			ws_plan_sources: "Sources",
			ws_plan_destination: "Destination des données",
			ws_plan_model: "Modèle",
			ws_plan_limits: "Limites",
			ws_approve: "Autoriser et exécuter",
			ws_approval_note: "L'autorisation est liée à ce plan. Une modification substantielle exige une nouvelle autorisation.",
			ws_state_draft: "Brouillon",
			ws_state_awaiting_approval: "En attente d'autorisation",
			ws_state_ready: "Prêt",
			ws_state_running: "En cours",
			ws_state_succeeded: "Terminé",
			ws_state_failed: "Échec",
			ws_state_cancelled: "Interrompu",
			ws_state_needs_attention: "Attention requise",
			ws_steps: "Étapes",
			ws_step_prepared: "Préparée",
			ws_step_dispatched: "Envoyée",
			ws_step_succeeded: "Terminée",
			ws_step_failed: "Échec",
			ws_step_unknown: "Résultat inconnu",
			ws_step_unknown_note: "Envoyée sans résultat confirmé. Elle n'est pas répétée automatiquement.",
			ws_step_account_note: "Non envoyé : le compte lié n'a pas de solde observé en vigueur, de solde suffisant ou de prix unitaire connu. Vérifiez-le dans Comptes.",
			ws_cancel: "Interrompre",
			api_field_pokemon_name: "Nom du Pokémon",
			api_field_owner: "Propriétaire",
			api_field_repo: "Dépôt",
			api_field_state: "État",
			api_field_page: "Page",
			api_field_per_page: "Par page",
			api_field_indicator: "Indicateur",
			api_field_format: "Format",
			api_op_get_public_repository_issues: "Obtenir les problèmes du dépôt public",
			api_op_get_public_repository_pulls: "Obtenir les pull requests du dépôt public",
			api_op_get_pokemon: "Obtenir le Pokémon",
			api_op_get_country_indicator: "Obtenir l'indicateur du pays",
			api_op_get_apod: "Image astronomique du jour",
			repoUrl: "URL du référentiel",
			recipe_param_repoUrl: "URL du référentiel",
			ws_cancelled_note: "Interrompu. Dernier état enregistré affiché.",
			ws_evidence: "Preuves consultées",
			ws_evidence_consulted: "consultée le {date}",
			ws_evidence_not_retrieved: "non récupérée",
			ws_evidence_empty: "Aucune source consultée pour le moment.",
			ws_result: "Résultat",
			ws_delete_confirm: "Supprimer définitivement ce projet, ses rapports et son historique ? Les fichiers exportés et les originaux importés seront conservés.",
			ws_import: "Importer le contexte sélectionné",
			ws_context: "Contexte pour cette exécution",
			project_choose_folder: "Choisir un dossier (facultatif)",
			ws_import_note: "Sélectionnez les messages ou les textes de pièces jointes enregistrés à copier localement. Si le texte manque, joignez à nouveau le fichier. Les originaux sont conservés. Réimporter ouvre la copie existante. Rien ne sera exécuté.",
			ws_constraints: "Contraintes (une par ligne)",
			ws_compare: "Comparer au rapport précédent (− supprimé, + ajouté)",
			ws_result_open: "Ouvrir",
			ws_persisted_note: "Enregistré dans l'espace de travail local. Ce n'est pas un fichier exporté.",
			ws_export_folder: "Enregistrer dans le dossier du projet",
			ws_export_download: "Télécharger",
			ws_export_done: "Exporté sous {name}",
			ws_export_failed: "Échec de l'export. Le rapport reste enregistré dans l'espace de travail.",
			ws_export_overwrite: "Écraser {name} dans le dossier du projet ?",
			ws_export_no_folder: "Aucun dossier de projet accordé dans ce navigateur. L'accès devra peut-être être redonné après réouverture.",
			ws_usage_title: "Votre usage ce mois-ci",
			ws_usage_charged: "Facturé par Uptokey",
			ws_usage_reference: "Valeur de référence de l'usage",
			ws_usage_reference_note: "Estimation aux tarifs publics de référence. Ce n'est ni une facture ni une économie confirmée.",
			ws_usage_coverage: "Couverture de la mesure",
			ws_usage_coverage_value: "{included} sur {observed} appels",
			ws_usage_details: "Vérifier le calcul",
			ws_usage_basis_provider: "rapporté par le fournisseur",
			ws_usage_basis_estimated: "estimé",
			ws_usage_basis_unknown: "base inconnue",
			ws_usage_cov_included: "incluse",
			ws_usage_cov_missing_usage: "sans usage rapporté",
			ws_usage_cov_missing_tariff: "sans tarif",
			ws_usage_cov_not_comparable: "non comparable",
			ws_usage_cov_estimated: "usage estimé",
			ws_usage_cov_local_cache: "réutilisée localement",
			ws_usage_access_public: "accès public",
			ws_usage_access_byok: "votre propre clé",
			ws_usage_access_local: "exécution locale",
			ws_usage_access_hosted: "accès hébergé",
			ws_usage_charge_unconfirmed: "Toutes les requêtes de cette période n'ont pas confirmé de facturation : le total reste inconnu plutôt que nul.",
			ws_usage_no_aggregable: "Aucune requête n'avait à la fois un usage rapporté et un tarif correspondant.",
			ws_usage_cached: "{cached} en cache",
			ws_usage_rate: "{input}/M entrée · {output}/M sortie",
			ws_usage_reused: "réponse réutilisée",
			ws_usage_tariff: "tarif {id} · {checkedAt}",
			ws_usage_byok_note: "Facturé par Uptokey n'est pas le coût total : le BYOK peut être facturé directement par le fournisseur, et un modèle local consomme votre propre matériel et énergie.",
			ws_usage_units: "{input} entrée · {output} sortie",
			ws_usage_empty: "Aucun appel mesuré sur cette période.",
			ws_step_pending: "En attente",
			ws_plan_limits_value: "{steps} étapes · {calls} appels · {tokens} sortie · {seconds} s",
			ws_capability_unavailable: "non exécutable",
			ws_evidence_note: "L'instantané consigne ce qui a été lu à ce moment-là ; cela ne rend pas le contenu vrai.",
			"workflow.sources.crossref.search.title": "Rechercher dans Crossref",
			"workflow.sources.crossref.search.description": "Recherche des articles et des DOI dans le catalogue public Crossref.",
			"workflow.sources.open-library.search.title": "Rechercher dans Open Library",
			"workflow.sources.open-library.search.description": "Recherche des livres et des auteurs dans le catalogue public Open Library.",
			"workflow.sources.pubmed.search.title": "Rechercher dans PubMed",
			"workflow.sources.pubmed.search.description": "Recherche de la littérature biomédicale dans PubMed.",
			"workflow.sources.openalex.search.title": "Rechercher dans OpenAlex",
			"workflow.sources.openalex.search.description": "Recherche des travaux scientifiques dans le catalogue public OpenAlex.",
			"workflow.sources.archive.search.title": "Rechercher dans les archives",
			"workflow.sources.archive.search.description": "Recherche des documents historiques dans la source d'archives.",
			"workflow.sources.rss.read.title": "Lire le flux RSS",
			"workflow.sources.rss.read.description": "Récupère les entrées d’un flux RSS ou Atom public.",
			"workflow.capabilities.project_write.title": "Écrire les fichiers du projet",
			"workflow.capabilities.project_write.description": "Crée ou modifie des fichiers dans le dossier autorisé du projet.",
			chat_edit: "Modifier",
			chat_regenerate: "Régénérer",
			chat_save_submit: "Enregistrer et envoyer",
			chat_cancel_edit: "Annuler",
			cap_discovery_title: "Découverte des capacités",
			cap_discovery_search_placeholder: "Rechercher des capacités par nom, étiquette ou destination...",
			cap_filter_all: "Toutes",
			cap_filter_available: "Disponibles",
			cap_filter_configurable: "Configurables",
			cap_filter_unavailable: "Indisponibles",
			cap_tier_available: "Disponible",
			cap_tier_configurable: "Configurable",
			cap_tier_unavailable: "Indisponible",
			cap_action_open_form: "Ouvrir le formulaire",
			cap_action_prepare: "Préparer le plan",
			cap_action_configure: "Configurer",
			cap_action_unavailable: "Indisponible",
			cap_action_details: "Détails",
			cap_action_hide_details: "Masquer les détails",
			cap_action_clear_search: "Effacer la recherche",
			cap_filter_group_label: "Filtrer les capacités par disponibilité",
			cap_label_destination: "Destination",
			cap_label_effect: "Effet",
			cap_label_limits: "Limites d'exécution",
			cap_label_tags: "Étiquettes",
			cap_label_schemas: "Schémas d'entrée/sortie",
			cap_label_retry_class: "Politique de réessai",
			cap_empty_title: "Aucune capacité trouvée",
			cap_empty_desc: "Aucune capacité ne correspond à la recherche ou aux filtres actuels.",
			cap_empty_unregistered: "Aucune capacité n'a encore été enregistrée dans cet espace de travail.",
			cap_reason_executable: "Prête pour préparer le plan d'exécution",
			cap_reason_catalogued: "Cataloguée : configuration supplémentaire requise",
			cap_reason_missing_scopes: "Autorisations requises : {scopes}",
			cap_reason_scopes_unknown: "Autorisations non confirmées ; requis : {scopes}",
			cap_reason_unavailable: "Non exécutable dans cet environnement",
			cap_reason_incompatible_schema: "Métadonnées de capacité incompatibles ou incomplètes",
			cap_reason_unknown: "Métadonnées de descripteur incomplètes ou inconnues",
			cap_unknown_title: "Capacité : {id}",
			cap_unknown_desc: "Métadonnées du descripteur indisponibles.",
			cap_effect_read_external: "Lecture externe",
			cap_effect_write_external: "Écriture externe",
			cap_effect_inference: "Inférence",
			cap_effect_produce_artifact: "Produire un artefact",
			cap_effect_execute_local: "Exécuter localement",
			cap_destination_public: "Publique : {id}",
			cap_destination_local: "Locale : {id}",
			cap_destination_provider: "Fournisseur : {id}",
			cap_destination_unknown: "Destination : {id}",
			cap_limits: "{steps} étapes · {calls} appels · {tokens} jetons · {timeout}s",
			cap_results_count: "{count} capacités trouvées",
			cap_results_sr: "Affichage de {count} capacités",
			cx_accounts_title: "Comptes et autorisations",
			cx_connections_loading: "Chargement des connexions…",
			cx_connections_failed: "Impossible de charger les connexions. Réessayez.",
			cx_connections_retry: "Réessayer",
			cx_accounts_sub: "Un fournisseur, plusieurs comptes. Les clés restent sur cet appareil.",
			cx_add_account: "Ajouter un compte",
			cx_provider_id: "ID du fournisseur",
			cx_access_mode: "Mode d’accès",
			cx_get_access: "Obtenir l’accès",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "Configurer",
			cx_label: "Nom",
			cx_secret: "Clé",
			cx_secret_hint: "Vide annule.",
			cx_endpoint: "Endpoint",
			cx_models: "Modèles (séparés par des virgules)",
			cx_add: "Ajouter",
			cx_save: "Enregistrer",
			cx_test: "Tester",
			cx_test_all: "Tout tester",
			cx_test_inference: "Tester avec appels fournisseur",
			cx_testing: "Test en cours…",
			cx_consent: "Autoriser des appels plafonnés",
			cx_cap_usd: "Plafond (USD)",
			cx_cancel: "Annuler",
			cx_revoke: "Révoquer",
			cx_confirm_revoke: "Cliquez à nouveau pour confirmer",
			cx_reconnect: "Reconnecter",
			cx_rename: "Renommer",
			cx_disable: "Désactiver",
			cx_enable: "Activer",
			cx_primary: "Définir principal",
			cx_install: "Télécharger",
			cx_model: "Modèle",
			cx_size_unknown: "Taille indisponible",
			cx_no_accounts: "Aucun compte. Ajoutez le premier pour le tester ici.",
			cx_resume: "Reprendre",
			cx_connect_oauth: "Connecter avec {provider}",
			cx_error: "Erreur : {type}",
			cx_job_state: "Tâche : {state}",
			cx_st_healthy: "Sain",
			cx_st_degraded: "Dégradé",
			cx_st_unauthenticated: "Sans clé",
			cx_st_disabled: "Désactivé",
			cx_st_unconfigured: "Non configuré",
			cx_st_unknown: "Inconnu",
			cx_st_expired: "Expiré",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "Non autorisé",
			cx_rs_rate_limited: "Limite dépassée",
			cx_rs_timeout: "Délai dépassé",
			cx_rs_unreachable: "Injoignable",
			cx_rs_skipped: "Ignoré",
			cx_rs_failed: "Échoué",
			cap_scope_required: "Autorisations requises",
			cap_no_action_available: "Capacité de référence : aucun formulaire d'exécution directe dans cet espace de travail",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		de: {
			ws_embeddings_title: "Embeddings",
			ws_embeddings_description: "Vektoren mit dem verbundenen Modell erstellen.",
			ws_automation_schedule_authorize: "Zeitplan autorisieren",
			ws_automation_schedule_scope: "Wiederkehrende Berechtigung mit begrenztem Umfang, Anzahl und Gültigkeit.",
			ws_automation_channel_resend: "Mit Resend senden",
			ws_automation_channel_brevo: "Mit Brevo senden",
			ws_automation_channel_slack: "Mit Slack senden",
			ws_automation_channel_description: "Geprüfte Nachricht nach der Autorisierung senden.",
			classification_semantic_title: "Mit TypeSafe klassifizieren",
			classification_semantic_note: "Nur den ausgewählten Text analysieren; das Ergebnis autorisiert keine Aktionen.",
			df_model_plugin: "Referenz auf das Modell-Plugin",
			df_plugin_version: "Referenzierte Version",
			df_plugin_hash: "Deklarierter SHA-256-Wert",
			df_plugin_note: "In der Vorlage deklarierte Referenz. Es wird kein Plugin-Paket installiert und kein Paket-Hash geprüft.",
			df_temperature: "Temperatur",
			df_top_p: "Top-p",
			df_title: "Dify-Vorlage importieren",
			df_profile: "Unterstütztes Profil: Start → LLM → Ende mit einer Texteingabe. Werkzeuge, Code, RAG, Umgebungsvariablen und Werkzeug-Plugins sind ausgeschlossen. Referenzen auf Modell-Plugins können ohne Installation gelesen werden.",
			df_file: "Lokale YAML-Datei",
			df_file_help: "Bis zu {bytes} Bytes. Lokal gelesen; die YAML-Datei wird nicht gespeichert.",
			df_source_model: "Modell in der Vorlage",
			df_target_model: "Konfiguriertes Modell für diesen Plan",
			df_mapping: "Das ursprüngliche Modell dient als Referenz. Die ausgefüllten Nachrichten verwenden nach der Genehmigung ausschließlich das konfigurierte Gateway-Modell.",
			df_template: "Vorlage",
			df_max_tokens: "Maximale Ausgabetokens",
			df_prepare: "Plan vorbereiten",
			df_prepare_note: "Es werden nur die ausgefüllten Nachrichten der Vorlage verwendet. Bisheriger Chatverlauf, Anhänge, Recherchequellen und der aktuelle Entwurf sind ausgeschlossen. Die Ausführung erfordert eine separate Genehmigung.",
			df_file_error: "Wählen Sie eine nicht leere .yaml- oder .yml-Datei mit höchstens {bytes} Bytes. Umgebungsdateien werden nicht akzeptiert.",
			df_invalid: "Vorlage abgelehnt. Verwenden Sie das Profil Start → LLM → Ende ohne nicht unterstützte Funktionen oder Einstellungen.",
			df_limit: "Die Datei oder YAML-Struktur überschreitet die unterstützten Grenzen.",
			df_input_error: "Geben Sie den erforderlichen Text mit höchstens {max} Zeichen und eine Ausgabegrenze von 1 bis 4096 ein.",
			df_payload_error: "Die ausgefüllte Vorlage überschreitet die Chatgrenze von 12.000 Bytes. Kürzen Sie den Text oder die Eingabe.",
			df_read_error: "Die ausgewählte Datei konnte nicht gelesen werden.",
			mu_title: "Modelle und Kontingente",
			mu_refresh: "Aktualisieren",
			mu_no_models: "Keine Daten zu konfigurierten Modellen.",
			mu_provider_scope: "Gemeinsames lokales Kontingent der konfigurierten Modelle dieses Anbieters.",
			mu_quota_unknown: "Kontingentabrechnung nicht verfügbar.",
			mu_table_note: "Reservierungen / konfigurierte lokale Grenzen",
			mu_window: "Zeitraum",
			mu_reserved_calls: "Reservierte Aufrufe",
			mu_reserved_tokens: "Reservierte Tokens",
			mu_minute: "Aktuelle Minute",
			mu_day: "Aktueller Tag",
			mu_reservation_note: "Tokenreservierungen umfassen die geschätzte Eingabe und die maximal erlaubte Ausgabe. Sie stellen keinen gemessenen Verbrauch dar.",
			mu_presented_run: "Angezeigte Ausführung",
			mu_usage_unknown: "Gemessener Verbrauch nicht verfügbar.",
			mu_input_tokens: "Gemeldete Eingabetokens",
			mu_output_tokens: "Gemeldete Ausgabetokens",
			mu_receipt_coverage: "Versuche mit vollständig gemeldetem Verbrauch / Versuche dieser Ausführung",
			mu_subset_note: "Die Zahlen enthalten nur gemeldete Messungen. Fehlende Messungen bleiben unbekannt; diese Zahlen bilden nicht den gesamten Verbrauch ab.",
			mu_router_usage: "Direkte Proxyaufrufe",
			mu_router_scope: "Erfolgreiche direkte Routerantworten seit dem Start dieses Prozesses. Dieser Zähler schließt Workspace-Gatewayaufrufe aus und wird nicht dauerhaft gespeichert.",
			mu_with_usage: "Antworten mit gemeldetem Verbrauch",
			mu_without_usage: "Antworten ohne gemeldeten Verbrauch",
			mu_in_flight: "Laufende Antworten",
			mu_interrupted: "Unterbrochene Antworten",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "Vorschau gekürzt. Die vollständige Antwort steht nach erfolgreicher Ausführung im endgültigen Ergebnis.",
			ws_gateway_reconnect: "Erneut verbinden, um den Status dieser Aufgabe zu prüfen.",
			ws_gateway_payload: "Zu sendende Nachrichten",
			ws_gateway_text_only: "Nur Text: Anhänge entfernen und keine Forschungsquelle auswählen.",
			ws_gateway_size: "Das gesamte Gespräch darf 12.000 Bytes nicht überschreiten. Neuen Chat starten oder Text kürzen.",
			ws_gateway_title: "Chat",
			ws_gateway_description: "Sendet die angezeigten Nachrichten nach Genehmigung genau einmal.",
			ws_browser_title: "Prüfung einer lokalen Seite",
			ws_speech_playback_error: "Dieses Audio konnte nicht abgespielt werden. Die Generierung wird nicht automatisch wiederholt.",
			ws_image_prepare: "Bilder vorbereiten",
			ws_video_title: "Video",
			ws_video_limits_value: "{calls} Aufrufe · insgesamt {seconds}s",
			ws_video_description: "Vor dem Senden prüfen. Verfügbare Optionen hängen vom konfigurierten Modell ab.",
			ws_video_duration: "Dauer (Sekunden)",
			ws_video_ratio: "Seitenverhältnis",
			ws_video_resolution: "Auflösung",
			ws_video_audio: "Audio erzeugen",
			ws_video_seed: "Startwert (optional)",
			ws_video_prepare: "Videoanfrage prüfen",
			ws_video_invalid: "Videooptionen prüfen oder erneut verbinden.",
			ws_video_download: "MP4 herunterladen",
			ws_video_load: "Video laden",
			ws_video_stop_notice: "Das Beenden der Überwachung bricht die Erstellung beim Anbieter nicht ab.",
			ws_video_resume: "Überwachung fortsetzen",
			ws_video_status_pending: "In der Warteschlange des Anbieters",
			ws_video_status_in_progress: "Wird beim Anbieter erstellt",
			ws_video_status_completed: "Erstellung beim Anbieter abgeschlossen",
			ws_video_status_failed: "Erstellung beim Anbieter fehlgeschlagen",
			ws_video_status_cancelled: "Vom Anbieter abgebrochen",
			ws_video_status_expired: "Beim Anbieter abgelaufen",
			ws_video_poll_title: "Video verfolgen",
			ws_video_poll_description: "Bekannten Auftrag abfragen, ohne ein weiteres Video zu erstellen.",
			ws_video_content_title: "Video abrufen",
			ws_video_content_description: "Fertiges Ergebnis in den Arbeitsbereich herunterladen.",
			ws_image_title: "Bilder",
			ws_image_description: "Plan vorbereiten; Bilder werden erst nach Freigabe erzeugt. Die Unterstützung hängt vom Anbieter ab.",
			ws_image_prompt: "Beschreibung",
			ws_image_count: "Bildanzahl",
			ws_image_size: "Größe (auto oder BxH)",
			ws_image_quality: "Qualität (optional)",
			ws_image_style: "Stil (optional)",
			ws_image_load: "Bild laden",
			ws_image_invalid: "Bild konnte nicht vorbereitet oder geladen werden. Anfrage und Verbindung prüfen.",
			ws_image_download: "Bild herunterladen",
			ws_speech_title: "Sprache erzeugen",
			ws_speech_description: "Wandelt nach Genehmigung ausschließlich den unten eingegebenen Text mit dem angezeigten Modell in Audio um.",
			ws_speech_input: "Zu sprechender Text",
			ws_speech_prepare: "Sprachplan vorbereiten",
			ws_speech_invalid: "Gib Text innerhalb der lokalen Grenze von 12.000 UTF-8-Bytes ein.",
			ws_speech_result: "Erzeugtes Audio",
			ws_speech_result_note: "KI-generiertes Audio. Die Wiedergabe beginnt erst auf deinen Wunsch.",
			ws_speech_load: "Audio laden",
			ws_speech_loading: "Audio wird geladen…",
			ws_speech_audio_error: "Das Audio konnte nicht geladen und geprüft werden. Versuche es erneut zu laden.",
			ws_speech_limits_value: "{calls} Generierungen · {seconds}s",
			ws_transcription_title: "Audio transkribieren",
			ws_transcription_description: "Nach der Freigabe das gewählte Audio mit dem angezeigten Modell in prüfbaren Text transkribieren.",
			ws_transcription_file: "Audiodatei (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "Sprache (optional, ISO 639-1)",
			ws_transcription_prepare: "Transkriptionsplan vorbereiten",
			ws_transcription_invalid: "Wähle eine MP3-Datei und einen zweibuchstabigen Sprachcode oder lass das Feld leer.",
			ws_transcription_result: "Transkript",
			ws_browser_fill_title: "Felder der lokalen Seite ausfüllen",
			ws_browser_fill_description: "Nach Genehmigung werden die angezeigten Felder ausgefüllt und die Seite erfasst. Das Formular wird nicht gesendet; eine Speicherung auf dem Server wird nicht bestätigt.",
			ws_browser_fill_field: "Feld {number}",
			ws_browser_fill_label: "Genaue Feldbeschriftung",
			ws_browser_fill_value: "Wert",
			ws_browser_fill_empty: "Ein leerer Wert leert das Feld.",
			ws_browser_fill_add: "Feld hinzufügen",
			ws_browser_fill_prepare: "Zur Prüfung vorbereiten",
			ws_browser_fill_invalid: "Verwende eine URL von {origin} und 1–8 unterschiedliche Feldbeschriftungen (höchstens 200 Zeichen). Jeder Wert erlaubt 2.000 Zeichen; kürze die Werte, falls die gesamte Anfrage zu groß ist.",
			ws_browser_fill_local: "Nur {origin}. Seitenskripte sind deaktiviert.",
			ws_browser_fill_limits_value: "{steps} Schritte · {calls} Aktionen · {seconds}s",
			ws_browser_description: "Prüft nach Genehmigung eine lokale Seite, ohne Klicks oder Interaktion mit Formularen.",
			ws_tools_result_prepare: "Antwort mit diesem Ergebnis vorbereiten",
			project_changeset_title: "Vorgeschlagene Dateiänderungen",
			project_changeset_note: "Das Modell hat diese Änderungen vorgeschlagen. Es wird nichts geschrieben, bevor du den Plan genehmigst; der Daemon prüft die Hashes vor dem Schreiben.",
			project_apply: "Prüfen und anwenden",
			project_apply_busy: "Wird vorbereitet…",
			project_apply_started: "Plan genehmigt. Der Schreiblauf wurde gestartet; öffne den Arbeitsbereich neu, um das Ergebnis zu sehen.",
			project_apply_bind_first: "Binde den Ordner über den lokalen Proxy, bevor du Änderungen anwendest.",
			project_apply_unavailable: "Das Anwenden von Änderungen ist in dieser Sitzung nicht verfügbar.",
			ws_tools_result_consent: "Dieses Ergebnis wird erst nach Ihrer Genehmigung des neuen Plans an das Modell gesendet.",
			ws_tools_enable: "Lokale Aktionen im Chat vorschlagen",
			ws_tools_description: "Ausgewählte Werkzeuge erlauben Aktionsvorschläge. Jede Aktion benötigt einen eigenen Plan und Ihre Zustimmung.",
			ws_tools_proposal: "Aktionsvorschlag",
			ws_tools_not_executed: "Diese Nachricht ist ein Vorschlag. Eine Aktion vorzubereiten führt sie nicht aus; genehmigen Sie zur Ausführung den neuen Plan.",
			ws_tools_prepare: "Diese Aktion vorbereiten",
			ws_filesystem_title: "Metadaten lokaler Dateien",
			ws_filesystem_tool: "Werkzeug",
			ws_filesystem_path: "Relativer Pfad",
			ws_filesystem_list: "Verzeichnis auflisten",
			ws_filesystem_info: "Dateiinformationen",
			ws_filesystem_description: "Nur Namen und Metadaten im konfigurierten Ordner. Keine Dateiinhalte oder Änderungen.",
			ws_filesystem_unavailable: "Lokale Dateiwerkzeuge nicht verfügbar.",
			ws_filesystem_invalid: "Pfad prüfen oder neu verbinden, um Werkzeuge zu aktualisieren. Danach einen neuen Plan vorbereiten.",
			ws_browser_open: "Lokale Seite prüfen",
			ws_composition_open: "Bedingter nächster Schritt",
			ws_composition_description: "Prüfen Sie den ausgewählten lokalen Text unter Beachtung der Groß- und Kleinschreibung. Ein Treffer schlägt nur eine weitere Prüfung vor, die eine neue Genehmigung erfordert.",
			ws_composition_contains: "Wenn das Ergebnis enthält",
			ws_composition_next: "Prüfung dieser URL vorschlagen",
			ws_composition_check: "Bedingung prüfen",
			ws_composition_no_match: "Der Text wurde nicht gefunden. Kein Folgeplan erstellt.",
			ws_composition_ready: "Die Bedingung ist erfüllt. Prüfen Sie den Folgeplan vor der Genehmigung.",
			ws_composition_review: "Diese Verknüpfung muss geprüft werden. Kein weiterer Schritt wurde ausgeführt.",
			ws_composition_review_plan: "Folgeplan prüfen",
			ws_browser_url: "URL der lokalen Seite",
			ws_browser_prepare: "Prüfung vorbereiten",
			ws_browser_invalid: "Gib eine vollständige URL mit dem Ursprung {origin} ein. Die Prüfung beginnt erst nach Genehmigung.",
			ws_browser_limits_value: "{steps} Schritte · {calls} Prüfungen · {seconds}s",
			ws_download_requested: "Download für {name} angefordert. Prüfe die Downloads im Browser.",
			title: "Deine KI. Echte Quellen.",
			connect: "Verbinden",
			disconnect: "Trennen",
			connected: "Verbunden",
			offline: "Offline",
			connecting: "Verbinde…",
			send: "Senden",
			stop: "Stopp",
			placeholder: "Frage stellen… @ für Modelle oder Quellen nutzen.",
			hint: "Strg+Eingabe senden · Esc stoppen · Mikrofon diktieren · @ Erwähnungen · Anhänge",
			model: "Modell",
			sources: "Recherche",
			newChat: "Neuer Chat",
			empty_title: "Deine KI. Echte Quellen.",
			empty_body: "Verbinde den lokalen Proxy (127.0.0.1:21435), wähle ein lokales oder BYOK-Modell, optional @pubmed / @crossref / @open-library, und frage. Schlüssel bleiben auf diesem Gerät.",
			you: "Du",
			ai: "KI",
			searching: "Suche Referenzen…",
			answering: "Nachdenken…",
			queryLabel: "Suchbegriffe",
			queryHint: "Mindestens 2 Zeichen für die Suche",
			local: "Lokal",
			cloud: "Cloud BYOK",
			research: "Recherche",
			connections: "Verbindungen",
			history: "Verlauf",
			theme: "Design",
			theme_dark: "Dunkel",
			theme_light: "Hell",
			theme_auto: "Auto",
			keys_local: "Schlüssel bleiben auf dem Gerät",
			attach: "Dateien anhängen",
			remove: "Entfernen",
			stop_kept: "Gestoppt — Teilantwort behalten",
			unknown: "unbekannt",
			cost_unknown: "Kosten: unbekannt",
			fallback_on: "Fallback autorisiert",
			disabled_zai: "nur Recherche / auf Proxy blockiert",
			disabled_openalex: "auf Proxy nicht zugelassen",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "offline",
			runtime_ok: "erreichbar",
			no_local_models: "Noch keine lokalen Modelle gefunden.",
			no_history: "Noch keine gespeicherten Chats. Starte einen — er bleibt in diesem Browser.",
			attach_busy: "Lese Datei…",
			err_provision: "Bereitstellung fehlgeschlagen — läuft der Proxy auf 127.0.0.1:21435?",
			err_request: "Anfrage fehlgeschlagen",
			err_source: "Quellensuche fehlgeschlagen",
			err_source_rate: "Quellen-Ratenlimit erreicht — gleich erneut versuchen",
			err_capacity: "Lokale Kapazität ausgelastet — erneut versuchen",
			err_invalid: "Ungültige Anfrage",
			menu: "Seitenleiste öffnen",
			close_menu: "Seitenleiste schließen",
			lang: "Sprache",
			credits: "Guthaben",
			size_est: "Größe ca.",
			aliases: "Lokale Aliase",
			discovered: "Installierte Modelle",
			none_source: "Nur KI",
			papers: "Artikel",
			books: "Bücher",
			delete_chat: "Löschen",
			composer_disabled: "Verbinde den Proxy zum Chatten",
			connect_first: "Verbinde den Proxy zum Senden",
			more_options: "Mehr Optionen",
			hide_options: "Weniger Optionen",
			new_project: "Neues Projekt",
			projects: "Projekte",
			project_name: "Projektname",
			local_storage: "Lokal gespeichert",
			streaming: "Wird übertragen…",
			mic: "Diktieren",
			mic_stop: "Diktat beenden",
			mic_listening: "Hört zu…",
			mic_unsupported: "Diktat in diesem Browser nicht unterstützt",
			mic_denied: "Mikrofonzugriff verweigert",
			mic_error: "Diktat fehlgeschlagen",
			sidebar: "Seitenleiste",
			note_text_read_failed: "Textdatei konnte nicht gelesen werden — nur Name.",
			note_pdf_empty: "PDF enthält keinen extrahierbaren Text (nur Name).",
			note_pdf_unavailable: "PDF-Textextraktion nicht verfügbar — nur mit Name angehängt.",
			note_doc_binary: "Nicht unterstütztes Format — nur Name (.doc binär).",
			note_doc_unsupported: "Nicht unterstütztes Format — nur Name (docx).",
			note_doc_compressed: "Nicht unterstütztes Format — nur Name (docx komprimiert).",
			note_doc_besteffort: "Ungefährer docx-Text (kann unvollständig sein).",
			note_unsupported_parse: "Analyse nicht unterstützt — nur Name.",
			note_image_attached: "Bild angehängt ({name}, {size} Bytes). Wird nur an das Modell gesendet, wenn es Bildverarbeitung unterstützt; sonst lokale Vorschau.",
			note_image_preview_failed: "Bild angehängt ({name}) — Vorschau fehlgeschlagen.",
			note_audio_attached: "Audio angehängt ({name}, {size} Bytes) — dieser Client transkribiert kein Audio; nur Name und Größe werden geteilt.",
			note_unsupported_type: "Nicht unterstützter Dateityp — nur Name ({name}).",
			hint_prefer_local: "Lokale Laufzeit bevorzugen",
			hint_local_gemma: "Lokales Gemma-Modell",
			hint_local_qwen: "Lokales Qwen-Modell",
			hint_auto_route: "Automatische Weiterleitung",
			hint_same_as_auto: "Identisch mit uptokey-auto",
			hint_pubmed: "PubMed-Artikel",
			hint_crossref: "Crossref-DOIs",
			hint_open_library: "Open Library-Bücher",
			hint_local_model: "Lokales Modell",
			ws_title: "Rechercheauftrag",
			ws_open: "Recherchieren und Bericht erstellen",
			ws_hide: "Auftragsbereich ausblenden",
			ws_unavailable: "Die Ausführung im Arbeitsbereich ist noch nicht verbunden. Plan, Schritte, Belege und Export erscheinen hier, sobald der lokale Arbeitsbereich verfügbar ist.",
			ws_contract_mismatch: "Dieser Auftrag nutzt eine andere Vertragsversion als diese Oberfläche. Werte können unvollständig sein.",
			ws_goal: "Was soll dieser Auftrag tun?",
			ws_goal_placeholder: "z. B. Aktuelle Übersichtsarbeiten zu Vitamin D und Immunität",
			ws_create: "Auftrag anlegen",
			ws_update: "Auftrag aktualisieren",
			ws_save_recipe: "Routine speichern",
			ws_recipe_saved: "Routine gespeichert",
			ws_recipe_note: "Eine Routine speichert Parameter und Schritte. Sie enthält keine Schlüssel oder Berechtigungen und autorisiert die Ausführung nicht von selbst.",
			ws_plan: "Plan",
			ws_plan_sources: "Quellen",
			ws_plan_destination: "Datenziel",
			ws_plan_model: "Modell",
			ws_plan_limits: "Grenzen",
			ws_approve: "Autorisieren und ausführen",
			ws_approval_note: "Die Autorisierung ist an diesen Plan gebunden. Eine wesentliche Änderung erfordert eine neue Autorisierung.",
			ws_state_draft: "Entwurf",
			ws_state_awaiting_approval: "Wartet auf Autorisierung",
			ws_state_ready: "Bereit",
			ws_state_running: "Läuft",
			ws_state_succeeded: "Abgeschlossen",
			ws_state_failed: "Fehlgeschlagen",
			ws_state_cancelled: "Unterbrochen",
			ws_state_needs_attention: "Benötigt Aufmerksamkeit",
			ws_steps: "Schritte",
			ws_step_prepared: "Vorbereitet",
			ws_step_dispatched: "Gesendet",
			ws_step_succeeded: "Fertig",
			ws_step_failed: "Fehlgeschlagen",
			ws_step_unknown: "Unbekanntes Ergebnis",
			ws_step_unknown_note: "Gesendet ohne bestätigtes Ergebnis. Wird nicht automatisch wiederholt.",
			ws_step_account_note: "Nicht gesendet: Für das verknüpfte Konto fehlt ein gültiger beobachteter Saldo, ausreichendes Guthaben oder ein bekannter Stückpreis. Prüfen Sie es unter Konten.",
			ws_cancel: "Unterbrechen",
			api_field_pokemon_name: "Pokemon-Name",
			api_field_owner: "Besitzer",
			api_field_repo: "Repository",
			api_field_state: "Status",
			api_field_page: "Seite",
			api_field_per_page: "Pro Seite",
			api_field_indicator: "Indikator",
			api_field_format: "Format",
			api_op_get_public_repository_issues: "Abrufen öffentlicher Repository-Issues",
			api_op_get_public_repository_pulls: "Abrufen öffentlicher Repository-Pulls",
			api_op_get_pokemon: "Abrufen von Pokemon",
			api_op_get_country_indicator: "Abrufen Länderindikator",
			api_op_get_apod: "Astronomiebild des Tages",
			repoUrl: "Repository-URL",
			recipe_param_repoUrl: "Repository-URL",
			ws_cancelled_note: "Unterbrochen. Der zuletzt gespeicherte Stand wird gezeigt.",
			ws_evidence: "Geprüfte Belege",
			ws_evidence_consulted: "abgerufen am {date}",
			ws_evidence_not_retrieved: "nicht abgerufen",
			ws_evidence_empty: "Noch keine Quelle abgerufen.",
			ws_result: "Ergebnis",
			ws_delete_confirm: "Dieses Projekt samt Berichten und Verlauf dauerhaft löschen? Exportierte Dateien und importierte Originale bleiben erhalten.",
			ws_import: "Ausgewählten Kontext importieren",
			ws_context: "Kontext für diese Ausführung",
			project_choose_folder: "Ordner auswählen (optional)",
			ws_import_note: "Wählen Sie Nachrichten oder gespeicherte Anhangtexte zum lokalen Kopieren aus. Fehlt der Text, hängen Sie die Datei erneut an. Originale bleiben erhalten. Erneuter Import öffnet die bestehende Kopie. Es wird nichts ausgeführt.",
			ws_constraints: "Vorgaben (eine pro Zeile)",
			ws_compare: "Mit vorherigem Bericht vergleichen (− entfernt, + hinzugefügt)",
			ws_result_open: "Öffnen",
			ws_persisted_note: "Im lokalen Arbeitsbereich gespeichert. Das ist keine exportierte Datei.",
			ws_export_folder: "Im Projektordner speichern",
			ws_export_download: "Herunterladen",
			ws_export_done: "Exportiert als {name}",
			ws_export_failed: "Export fehlgeschlagen. Der Bericht bleibt im Arbeitsbereich gespeichert.",
			ws_export_overwrite: "{name} im Projektordner überschreiben?",
			ws_export_no_folder: "In diesem Browser wurde kein Projektordner freigegeben. Die Freigabe muss nach dem erneuten Öffnen eventuell wiederholt werden.",
			ws_usage_title: "Ihre Nutzung in diesem Monat",
			ws_usage_charged: "Von Uptokey berechnet",
			ws_usage_reference: "Referenzwert der Nutzung",
			ws_usage_reference_note: "Schätzung zu öffentlichen Referenztarifen. Keine Rechnung und keine bestätigte Ersparnis.",
			ws_usage_coverage: "Abdeckung der Messung",
			ws_usage_coverage_value: "{included} von {observed} Aufrufen",
			ws_usage_details: "Berechnung prüfen",
			ws_usage_basis_provider: "vom Anbieter gemeldet",
			ws_usage_basis_estimated: "geschätzt",
			ws_usage_basis_unknown: "unbekannte Grundlage",
			ws_usage_cov_included: "einbezogen",
			ws_usage_cov_missing_usage: "ohne gemeldete Nutzung",
			ws_usage_cov_missing_tariff: "ohne Tarif",
			ws_usage_cov_not_comparable: "nicht vergleichbar",
			ws_usage_cov_estimated: "geschätzte Nutzung",
			ws_usage_cov_local_cache: "lokal wiederverwendet",
			ws_usage_access_public: "öffentlicher Zugang",
			ws_usage_access_byok: "eigener Schlüssel",
			ws_usage_access_local: "lokale Ausführung",
			ws_usage_access_hosted: "gehosteter Zugang",
			ws_usage_charge_unconfirmed: "Nicht jeder Aufruf in diesem Zeitraum hat eine Abrechnung bestätigt, daher ist die Summe unbekannt und nicht null.",
			ws_usage_no_aggregable: "Kein Aufruf hatte zugleich eine gemeldete Nutzung und einen passenden Tarif.",
			ws_usage_cached: "{cached} aus dem Cache",
			ws_usage_rate: "{input}/M Eingabe · {output}/M Ausgabe",
			ws_usage_reused: "wiederverwendete Antwort",
			ws_usage_tariff: "Tarif {id} · {checkedAt}",
			ws_usage_byok_note: "Der von Uptokey berechnete Betrag entspricht nicht den Gesamtkosten: BYOK kann direkt vom Anbieter abgerechnet werden, und ein lokales Modell verbraucht Ihre eigene Hardware und Energie.",
			ws_usage_units: "{input} Eingabe · {output} Ausgabe",
			ws_usage_empty: "Kein gemessener Aufruf in diesem Zeitraum.",
			ws_step_pending: "Ausstehend",
			ws_plan_limits_value: "{steps} Schritte · {calls} Aufrufe · {tokens} Ausgabe · {seconds}s",
			ws_capability_unavailable: "nicht ausführbar",
			ws_evidence_note: "Der Snapshot hält fest, was zu diesem Zeitpunkt gelesen wurde; das macht den Inhalt nicht wahr.",
			"workflow.sources.crossref.search.title": "In Crossref suchen",
			"workflow.sources.crossref.search.description": "Sucht Artikel und DOIs im öffentlichen Crossref-Katalog.",
			"workflow.sources.open-library.search.title": "In Open Library suchen",
			"workflow.sources.open-library.search.description": "Sucht Bücher und Autoren im öffentlichen Open-Library-Katalog.",
			"workflow.sources.pubmed.search.title": "In PubMed suchen",
			"workflow.sources.pubmed.search.description": "Sucht biomedizinische Literatur in PubMed.",
			"workflow.sources.openalex.search.title": "In OpenAlex suchen",
			"workflow.sources.openalex.search.description": "Sucht wissenschaftliche Arbeiten im öffentlichen OpenAlex-Katalog.",
			"workflow.sources.archive.search.title": "In Archiven suchen",
			"workflow.sources.archive.search.description": "Sucht historische Aufzeichnungen in der Archivquelle.",
			"workflow.sources.rss.read.title": "RSS-Feed lesen",
			"workflow.sources.rss.read.description": "Ruft Einträge aus einem öffentlichen RSS- oder Atom-Feed ab.",
			"workflow.capabilities.project_write.title": "Projekdateien schreiben",
			"workflow.capabilities.project_write.description": "Erstellt oder bearbeitet Dateien im autorisierten Projektordner.",
			chat_edit: "Bearbeiten",
			chat_regenerate: "Neu generieren",
			chat_save_submit: "Speichern und senden",
			chat_cancel_edit: "Abbrechen",
			cap_discovery_title: "Funktionsentdeckung",
			cap_discovery_search_placeholder: "Funktionen nach Name, Tag oder Ziel durchsuchen...",
			cap_filter_all: "Alle",
			cap_filter_available: "Verfügbar",
			cap_filter_configurable: "Konfigurierbar",
			cap_filter_unavailable: "Nicht verfügbar",
			cap_tier_available: "Verfügbar",
			cap_tier_configurable: "Konfigurierbar",
			cap_tier_unavailable: "Nicht verfügbar",
			cap_action_open_form: "Formular öffnen",
			cap_action_prepare: "Plan vorbereiten",
			cap_action_configure: "Konfigurieren",
			cap_action_unavailable: "Nicht verfügbar",
			cap_action_details: "Details",
			cap_action_hide_details: "Details ausblenden",
			cap_action_clear_search: "Suche löschen",
			cap_filter_group_label: "Funktionen nach Verfügbarkeit filtern",
			cap_label_destination: "Ziel",
			cap_label_effect: "Effekt",
			cap_label_limits: "Ausführungslimits",
			cap_label_tags: "Tags",
			cap_label_schemas: "Eingabe-/Ausgabe-Schemata",
			cap_label_retry_class: "Wiederholungsrichtlinie",
			cap_empty_title: "Keine Funktionen gefunden",
			cap_empty_desc: "Keine Funktionen entsprechen der aktuellen Suche oder den Filtern.",
			cap_empty_unregistered: "In diesem Arbeitsbereich sind noch keine Funktionen registriert.",
			cap_reason_executable: "Bereit zur Vorbereitung des Ausführungsplans",
			cap_reason_catalogued: "Katalogisiert: erfordert zusätzliche Konfiguration",
			cap_reason_missing_scopes: "Erfordert Berechtigungen: {scopes}",
			cap_reason_scopes_unknown: "Berechtigungen unbestätigt; erforderlich: {scopes}",
			cap_reason_unavailable: "In dieser Umgebung nicht ausführbar",
			cap_reason_incompatible_schema: "Inkompatible oder unvollständige Fähigkeitsmetadaten",
			cap_reason_unknown: "Deskriptor-Metadaten unvollständig oder nicht erkannt",
			cap_unknown_title: "Funktion: {id}",
			cap_unknown_desc: "Deskriptor-Metadaten nicht verfügbar.",
			cap_effect_read_external: "Externes Lesen",
			cap_effect_write_external: "Externes Schreiben",
			cap_effect_inference: "Inferenz",
			cap_effect_produce_artifact: "Artefakt erstellen",
			cap_effect_execute_local: "Lokal ausführen",
			cap_destination_public: "Öffentlich: {id}",
			cap_destination_local: "Lokal: {id}",
			cap_destination_provider: "Anbieter: {id}",
			cap_destination_unknown: "Ziel: {id}",
			cap_limits: "{steps} Schritte · {calls} Aufrufe · {tokens} Token · {timeout}s",
			cap_results_count: "{count} Funktionen gefunden",
			cap_results_sr: "{count} Funktionen werden angezeigt",
			cx_accounts_title: "Konten und Berechtigungen",
			cx_connections_loading: "Verbindungen werden geladen…",
			cx_connections_failed: "Die Verbindungen konnten nicht geladen werden. Bitte erneut versuchen.",
			cx_connections_retry: "Erneut versuchen",
			cx_accounts_sub: "Ein Anbieter, mehrere Konten. Schlüssel bleiben auf diesem Gerät.",
			cx_add_account: "Konto hinzufügen",
			cx_provider_id: "Anbieter-ID",
			cx_access_mode: "Zugriffsmodus",
			cx_get_access: "Zugang erhalten",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "Konfigurieren",
			cx_label: "Name",
			cx_secret: "Schlüssel",
			cx_secret_hint: "Leer bricht ab.",
			cx_endpoint: "Endpunkt",
			cx_models: "Modelle (kommagetrennt)",
			cx_add: "Hinzufügen",
			cx_save: "Speichern",
			cx_test: "Testen",
			cx_test_all: "Alle testen",
			cx_test_inference: "Mit Anbieteraufrufen testen",
			cx_testing: "Wird getestet…",
			cx_consent: "Gedeckelte Anbieteraufrufe erlauben",
			cx_cap_usd: "Limit (USD)",
			cx_cancel: "Abbrechen",
			cx_revoke: "Widerrufen",
			cx_confirm_revoke: "Erneut klicken zum Bestätigen",
			cx_reconnect: "Neu verbinden",
			cx_rename: "Umbenennen",
			cx_disable: "Deaktivieren",
			cx_enable: "Aktivieren",
			cx_primary: "Als primär festlegen",
			cx_install: "Herunterladen",
			cx_model: "Modell",
			cx_size_unknown: "Größe unbekannt",
			cx_no_accounts: "Noch keine Konten. Fügen Sie das erste hinzu, um es hier zu testen.",
			cx_resume: "Fortsetzen",
			cx_connect_oauth: "Mit {provider} verbinden",
			cx_error: "Fehler: {type}",
			cx_job_state: "Auftrag: {state}",
			cx_st_healthy: "Gesund",
			cx_st_degraded: "Beeinträchtigt",
			cx_st_unauthenticated: "Kein Schlüssel",
			cx_st_disabled: "Deaktiviert",
			cx_st_unconfigured: "Nicht konfiguriert",
			cx_st_unknown: "Unbekannt",
			cx_st_expired: "Abgelaufen",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "Nicht autorisiert",
			cx_rs_rate_limited: "Limit erreicht",
			cx_rs_timeout: "Zeitüberschreitung",
			cx_rs_unreachable: "Unerreichbar",
			cx_rs_skipped: "Übersprungen",
			cx_rs_failed: "Fehlgeschlagen",
			cap_scope_required: "Erfordert Berechtigungen",
			cap_no_action_available: "Referenzfunktion: kein direktes Ausführungsformular in diesem Arbeitsbereich",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		it: {
			ws_embeddings_title: "Embedding",
			ws_embeddings_description: "Crea vettori con il modello connesso.",
			ws_automation_schedule_authorize: "Autorizza pianificazione",
			ws_automation_schedule_scope: "Autorizzazione ricorrente limitata per ambito, numero e scadenza.",
			ws_automation_channel_resend: "Invia con Resend",
			ws_automation_channel_brevo: "Invia con Brevo",
			ws_automation_channel_slack: "Invia con Slack",
			ws_automation_channel_description: "Invia il messaggio revisionato dopo l’autorizzazione.",
			classification_semantic_title: "Classifica con TypeSafe",
			classification_semantic_note: "Analizza solo il testo selezionato; il risultato non autorizza azioni.",
			df_model_plugin: "Riferimento al plugin di modello",
			df_plugin_version: "Versione referenziata",
			df_plugin_hash: "SHA-256 dichiarato",
			df_plugin_note: "Riferimento dichiarato nel template. Nessun pacchetto di plugin viene installato e nessun hash di pacchetto viene verificato.",
			df_temperature: "Temperatura",
			df_top_p: "Top-p",
			df_title: "Importa template Dify",
			df_profile: "Profilo supportato: inizio → LLM → fine con un input di testo. Strumenti, codice, RAG, variabili d’ambiente e plugin di strumenti restano esclusi. I riferimenti ai plugin di modello possono essere letti senza installazione.",
			df_file: "File YAML locale",
			df_file_help: "Fino a {bytes} byte. Lettura locale; il file YAML non viene salvato.",
			df_source_model: "Modello nel template",
			df_target_model: "Modello configurato per questo piano",
			df_mapping: "Il modello originale è mostrato come riferimento. I messaggi materializzati usano solo il modello configurato nel gateway, dopo l’approvazione.",
			df_template: "Template",
			df_max_tokens: "Token di uscita massimi",
			df_prepare: "Prepara piano",
			df_prepare_note: "Vengono usati solo i messaggi materializzati del template. Cronologia precedente, allegati, fonti di ricerca e bozza attuale sono esclusi. L’esecuzione richiede un’approvazione separata.",
			df_file_error: "Scegli un file .yaml o .yml non vuoto fino a {bytes} byte. I file d’ambiente non sono accettati.",
			df_invalid: "Template rifiutato. Usa il profilo inizio → LLM → fine senza funzionalità o impostazioni non supportate.",
			df_limit: "Il file o la struttura YAML supera i limiti supportati.",
			df_input_error: "Inserisci il testo obbligatorio entro {max} caratteri e un limite di uscita da 1 a 4096.",
			df_payload_error: "Il template materializzato supera il limite di 12.000 byte della chat. Abbrevia il testo o l’input.",
			df_read_error: "Impossibile leggere il file selezionato.",
			mu_title: "Modelli e quote",
			mu_refresh: "Aggiorna",
			mu_no_models: "Nessun dato sui modelli configurati.",
			mu_provider_scope: "Quota locale condivisa dai modelli configurati di questo fornitore.",
			mu_quota_unknown: "Contabilità della quota non disponibile.",
			mu_table_note: "Prenotazioni / limiti locali configurati",
			mu_window: "Periodo",
			mu_reserved_calls: "Chiamate prenotate",
			mu_reserved_tokens: "Token prenotati",
			mu_minute: "Minuto corrente",
			mu_day: "Giorno corrente",
			mu_reservation_note: "Le prenotazioni di token includono l’ingresso stimato e l’uscita massima consentita. Non rappresentano un consumo misurato.",
			mu_presented_run: "Esecuzione visualizzata",
			mu_usage_unknown: "Consumo misurato non disponibile.",
			mu_input_tokens: "Token di ingresso dichiarati",
			mu_output_tokens: "Token di uscita dichiarati",
			mu_receipt_coverage: "Tentativi con consumo completo dichiarato / tentativi di questa esecuzione",
			mu_subset_note: "Le cifre includono solo misurazioni dichiarate. Le misurazioni mancanti restano sconosciute; queste cifre non rappresentano tutto il consumo.",
			mu_router_usage: "Chiamate dirette del proxy",
			mu_router_scope: "Risposte dirette riuscite del Router dall’avvio di questo processo. Questo contatore esclude le chiamate del gateway del workspace e non viene conservato.",
			mu_with_usage: "Risposte con consumo dichiarato",
			mu_without_usage: "Risposte senza consumo dichiarato",
			mu_in_flight: "Risposte in corso",
			mu_interrupted: "Risposte interrotte",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "Anteprima troncata. La risposta completa sarà disponibile nel risultato finale al termine dell’esecuzione riuscita.",
			ws_gateway_reconnect: "Riconnettiti per controllare lo stato di questo lavoro.",
			ws_gateway_payload: "Messaggi da inviare",
			ws_gateway_text_only: "Solo testo: rimuovi gli allegati e non selezionare fonti di ricerca.",
			ws_gateway_size: "La conversazione completa deve rientrare in 12.000 byte. Avvia una nuova chat o abbrevia il testo.",
			ws_gateway_title: "Conversazione",
			ws_gateway_description: "Invia i messaggi mostrati una sola volta, dopo approvazione.",
			ws_browser_title: "Ispezione di una pagina locale",
			ws_speech_playback_error: "Impossibile riprodurre questo audio. La generazione non verrà ripetuta automaticamente.",
			ws_image_prepare: "Prepara immagini",
			ws_video_title: "Video",
			ws_video_limits_value: "{calls} chiamate · {seconds}s totali",
			ws_video_description: "Controlla prima di inviare. Le opzioni dipendono dal modello configurato.",
			ws_video_duration: "Durata (secondi)",
			ws_video_ratio: "Proporzioni",
			ws_video_resolution: "Risoluzione",
			ws_video_audio: "Genera audio",
			ws_video_seed: "Seme (facoltativo)",
			ws_video_prepare: "Rivedi richiesta video",
			ws_video_invalid: "Controlla le opzioni video o riconnettiti.",
			ws_video_download: "Scarica MP4",
			ws_video_load: "Carica video",
			ws_video_stop_notice: "Interrompere il monitoraggio non annulla la generazione presso il fornitore.",
			ws_video_resume: "Riprendi monitoraggio",
			ws_video_status_pending: "In coda presso il fornitore",
			ws_video_status_in_progress: "Generazione presso il fornitore",
			ws_video_status_completed: "Generazione completata presso il fornitore",
			ws_video_status_failed: "Generazione fallita presso il fornitore",
			ws_video_status_cancelled: "Annullato dal fornitore",
			ws_video_status_expired: "Scaduto presso il fornitore",
			ws_video_poll_title: "Monitora video",
			ws_video_poll_description: "Consulta il lavoro esistente senza creare un altro video.",
			ws_video_content_title: "Recupera video",
			ws_video_content_description: "Scarica il risultato completato nello spazio di lavoro.",
			ws_image_title: "Immagini",
			ws_image_description: "Prepara un piano; le immagini vengono generate solo dopo autorizzazione. Il supporto dipende dal fornitore.",
			ws_image_prompt: "Descrizione",
			ws_image_count: "Numero di immagini",
			ws_image_size: "Dimensioni (auto o LxA)",
			ws_image_quality: "Qualità (opzionale)",
			ws_image_style: "Stile (opzionale)",
			ws_image_load: "Carica immagine",
			ws_image_invalid: "Impossibile preparare o caricare l’immagine. Controlla richiesta e connessione.",
			ws_image_download: "Scarica immagine",
			ws_speech_title: "Genera voce",
			ws_speech_description: "Dopo l’approvazione, trasforma solo il testo inserito qui sotto in audio con il modello mostrato.",
			ws_speech_input: "Testo da pronunciare",
			ws_speech_prepare: "Prepara il piano vocale",
			ws_speech_invalid: "Inserisci un testo entro il limite locale di 12.000 byte UTF-8.",
			ws_speech_result: "Audio generato",
			ws_speech_result_note: "Audio generato dall’IA. La riproduzione inizia solo quando lo scegli.",
			ws_speech_load: "Carica audio",
			ws_speech_loading: "Caricamento dell’audio…",
			ws_speech_audio_error: "Impossibile caricare e verificare l’audio. Prova a caricarlo di nuovo.",
			ws_speech_limits_value: "{calls} generazioni · {seconds}s",
			ws_transcription_title: "Trascrivi audio",
			ws_transcription_description: "Dopo l’approvazione, trascrivi l’audio selezionato in testo rivedibile con il modello mostrato.",
			ws_transcription_file: "File audio (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "Lingua (opzionale, ISO 639-1)",
			ws_transcription_prepare: "Prepara il piano di trascrizione",
			ws_transcription_invalid: "Scegli un file MP3 e un codice di lingua di due lettere, oppure lascia vuoto.",
			ws_transcription_result: "Trascrizione",
			ws_browser_fill_title: "Compila i campi della pagina locale",
			ws_browser_fill_description: "Dopo l’approvazione, compila i campi mostrati e acquisisce la pagina. Il modulo non viene inviato e il salvataggio sul server non è confermato.",
			ws_browser_fill_field: "Campo {number}",
			ws_browser_fill_label: "Etichetta esatta del campo",
			ws_browser_fill_value: "Valore",
			ws_browser_fill_empty: "Un valore vuoto cancella il campo.",
			ws_browser_fill_add: "Aggiungi campo",
			ws_browser_fill_prepare: "Prepara per la revisione",
			ws_browser_fill_invalid: "Usa un URL di {origin} e da 1 a 8 etichette distinte (massimo 200 caratteri). Ogni valore ammette 2.000 caratteri; accorciali se la richiesta completa è troppo grande.",
			ws_browser_fill_local: "Solo {origin}. Gli script della pagina sono disattivati.",
			ws_browser_fill_limits_value: "{steps} passaggi · {calls} azioni · {seconds}s",
			ws_browser_description: "Ispeziona una pagina locale dopo l’approvazione, senza clic né interazione con i moduli.",
			ws_tools_result_prepare: "Prepara una risposta con questo risultato",
			project_changeset_title: "Modifiche ai file proposte",
			project_changeset_note: "Il modello ha proposto queste modifiche. Nulla viene scritto prima dell'approvazione del piano; il daemon verifica gli hash prima di scrivere.",
			project_apply: "Verifica e applica",
			project_apply_busy: "Preparazione…",
			project_apply_started: "Piano approvato. L'esecuzione di scrittura è iniziata; riapri lo spazio di lavoro per vedere il risultato.",
			project_apply_bind_first: "Collega la cartella tramite il proxy locale prima di applicare modifiche.",
			project_apply_unavailable: "L'applicazione delle modifiche non è disponibile in questa sessione.",
			ws_tools_result_consent: "Questo risultato sarà inviato al modello solo dopo la tua approvazione del nuovo piano.",
			ws_tools_enable: "Suggerisci azioni locali in chat",
			ws_tools_description: "Gli strumenti selezionati consentono di proporre azioni. Ogni azione richiede un piano separato e la tua approvazione.",
			ws_tools_proposal: "Proposta di azione",
			ws_tools_not_executed: "Questo messaggio è una proposta. Preparare un’azione non la esegue; approva il nuovo piano per eseguirla.",
			ws_tools_prepare: "Prepara questa azione",
			ws_filesystem_title: "Metadati dei file locali",
			ws_filesystem_tool: "Strumento",
			ws_filesystem_path: "Percorso relativo",
			ws_filesystem_list: "Elenca directory",
			ws_filesystem_info: "Informazioni sul file",
			ws_filesystem_description: "Solo nomi e metadati nella cartella configurata. Nessun contenuto o modifica dei file.",
			ws_filesystem_unavailable: "Strumenti per file locali non disponibili.",
			ws_filesystem_invalid: "Controlla il percorso o riconnettiti per aggiornare gli strumenti, poi prepara un nuovo piano.",
			ws_browser_open: "Ispeziona una pagina locale",
			ws_composition_open: "Passaggio successivo condizionale",
			ws_composition_description: "Controlla un testo letterale, distinguendo maiuscole e minuscole, nel risultato locale selezionato. Una corrispondenza propone solo un’altra ispezione, che richiede una nuova approvazione.",
			ws_composition_contains: "Se il risultato contiene",
			ws_composition_next: "Proponi l’ispezione di questo URL",
			ws_composition_check: "Verifica condizione",
			ws_composition_no_match: "Testo non trovato. Nessun piano successivo creato.",
			ws_composition_ready: "La condizione è soddisfatta. Esamina il piano successivo prima di approvarlo.",
			ws_composition_review: "Questa composizione richiede una revisione. Nessun passaggio successivo eseguito.",
			ws_composition_review_plan: "Esamina piano successivo",
			ws_browser_url: "URL della pagina locale",
			ws_browser_prepare: "Prepara l’ispezione",
			ws_browser_invalid: "Inserisci un URL completo dell’origine {origin}. L’ispezione inizia solo dopo l’approvazione.",
			ws_browser_limits_value: "{steps} passaggi · {calls} ispezioni · {seconds}s",
			ws_download_requested: "Download richiesto per {name}. Controlla i download del browser.",
			title: "La tua IA. Fonti reali.",
			connect: "Connetti",
			disconnect: "Disconnetti",
			connected: "Connesso",
			offline: "Offline",
			connecting: "Connessione…",
			send: "Invia",
			stop: "Ferma",
			placeholder: "Chiedi qualcosa… Usa @ per modelli o fonti di ricerca.",
			hint: "Ctrl+Invio invia · Esc ferma · microfono detta · @ menzioni · allegati",
			model: "Modello",
			sources: "Ricerca",
			newChat: "Nuova chat",
			empty_title: "La tua IA. Fonti reali.",
			empty_body: "Connettiti al proxy locale (127.0.0.1:21435), scegli un modello locale o BYOK, opzionalmente @pubmed / @crossref / @open-library, e chiedi. Le chiavi restano su questo dispositivo.",
			you: "Tu",
			ai: "IA",
			searching: "Ricerca riferimenti…",
			answering: "Sto pensando…",
			queryLabel: "Termini di ricerca",
			queryHint: "Almeno 2 caratteri per la ricerca",
			local: "Locale",
			cloud: "Cloud BYOK",
			research: "Ricerca",
			connections: "Connessioni",
			history: "Cronologia",
			theme: "Tema",
			theme_dark: "Scuro",
			theme_light: "Chiaro",
			theme_auto: "Auto",
			keys_local: "Le chiavi restano sul dispositivo",
			attach: "Allega file",
			remove: "Rimuovi",
			stop_kept: "Fermato — risposta parziale conservata",
			unknown: "sconosciuto",
			cost_unknown: "costo: sconosciuto",
			fallback_on: "fallback autorizzato",
			disabled_zai: "solo ricerca / bloccato sul proxy",
			disabled_openalex: "non ammesso sul proxy",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "offline",
			runtime_ok: "raggiungibile",
			no_local_models: "Nessun modello locale rilevato finora.",
			no_history: "Nessuna chat salvata. Iniziane una — rimarrà in questo browser.",
			attach_busy: "Lettura del file…",
			err_provision: "Impossibile effettuare il provisioning — il proxy è attivo su 127.0.0.1:21435?",
			err_request: "Richiesta non riuscita",
			err_source: "Ricerca fonti non riuscita",
			err_source_rate: "Limite di frequenza della fonte — riprova tra poco",
			err_capacity: "Capacità locale occupata — riprova",
			err_invalid: "Richiesta non valida",
			menu: "Apri barra laterale",
			close_menu: "Chiudi barra laterale",
			lang: "Lingua",
			credits: "Crediti",
			size_est: "dim. stim.",
			aliases: "Alias locali",
			discovered: "Modelli installati",
			none_source: "Solo IA",
			papers: "articoli",
			books: "libri",
			delete_chat: "Elimina",
			composer_disabled: "Connetti il proxy per chattare",
			connect_first: "Connetti il proxy per inviare",
			more_options: "Più opzioni",
			hide_options: "Meno opzioni",
			new_project: "Nuovo progetto",
			projects: "Progetti",
			project_name: "Nome del progetto",
			local_storage: "Salvato localmente",
			streaming: "In streaming…",
			mic: "Detta",
			mic_stop: "Interrompi dettatura",
			mic_listening: "In ascolto…",
			mic_unsupported: "Dettatura non supportata in questo browser",
			mic_denied: "Autorizzazione microfono negata",
			mic_error: "Dettatura non riuscita",
			sidebar: "Barra laterale",
			note_text_read_failed: "Impossibile leggere il file di testo — solo nome.",
			note_pdf_empty: "Il PDF non contiene testo estraibile (solo nome).",
			note_pdf_unavailable: "Estrazione testo PDF non disponibile — allegato solo per nome.",
			note_doc_binary: "Formato non supportato — solo nome (.doc binario).",
			note_doc_unsupported: "Formato non supportato — solo nome (docx).",
			note_doc_compressed: "Formato non supportato — solo nome (docx compresso).",
			note_doc_besteffort: "Testo docx approssimativo (potrebbe essere incompleto).",
			note_unsupported_parse: "Analisi non supportata — solo nome.",
			note_image_attached: "Immagine allegata ({name}, {size} byte). Inviata al modello solo se supporta immagini; altrimenti anteprima locale.",
			note_image_preview_failed: "Immagine allegata ({name}) — anteprima non riuscita.",
			note_audio_attached: "Audio allegato ({name}, {size} byte) — questo client non trascrive l’audio; vengono condivisi solo nome e dimensioni.",
			note_unsupported_type: "Tipo di file non supportato — solo nome ({name}).",
			hint_prefer_local: "Preferisci runtime locale",
			hint_local_gemma: "Modello Gemma locale",
			hint_local_qwen: "Modello Qwen locale",
			hint_auto_route: "Routing automatico",
			hint_same_as_auto: "Uguale a uptokey-auto",
			hint_pubmed: "Articoli PubMed",
			hint_crossref: "DOI Crossref",
			hint_open_library: "Libri Open Library",
			hint_local_model: "Modello locale",
			ws_title: "Lavoro di ricerca",
			ws_open: "Cerca e crea un report",
			ws_hide: "Nascondi il pannello del lavoro",
			ws_unavailable: "L'esecuzione dello spazio di lavoro non è ancora collegata. Piano, passaggi, prove ed esportazione compaiono qui quando lo spazio di lavoro locale sarà disponibile.",
			ws_contract_mismatch: "Questo lavoro usa una versione di contratto diversa da questa interfaccia. I valori possono essere incompleti.",
			ws_goal: "Che cosa deve fare questo lavoro?",
			ws_goal_placeholder: "es.: Revisioni recenti su vitamina D e immunità",
			ws_create: "Crea lavoro",
			ws_update: "Aggiorna lavoro",
			ws_save_recipe: "Salva routine",
			ws_recipe_saved: "Routine salvata",
			ws_recipe_note: "Una routine conserva parametri e passaggi. Non contiene chiavi né permessi e non autorizza l'esecuzione da sola.",
			ws_plan: "Piano",
			ws_plan_sources: "Fonti",
			ws_plan_destination: "Destinazione dei dati",
			ws_plan_model: "Modello",
			ws_plan_limits: "Limiti",
			ws_approve: "Autorizza ed esegui",
			ws_approval_note: "L’autorizzazione è vincolata a questo piano. Una modifica sostanziale richiede una nuova autorizzazione.",
			ws_state_draft: "Bozza",
			ws_state_awaiting_approval: "In attesa di autorizzazione",
			ws_state_ready: "Pronto",
			ws_state_running: "In esecuzione",
			ws_state_succeeded: "Completato",
			ws_state_failed: "Non riuscito",
			ws_state_cancelled: "Interrotto",
			ws_state_needs_attention: "Richiede attenzione",
			ws_steps: "Passaggi",
			ws_step_prepared: "Preparato",
			ws_step_dispatched: "Inviato",
			ws_step_succeeded: "Fatto",
			ws_step_failed: "Non riuscito",
			ws_step_unknown: "Risultato sconosciuto",
			ws_step_unknown_note: "Inviato senza risultato confermato. Non viene ripetuto automaticamente.",
			ws_step_account_note: "Non inviato: l’account collegato non ha un saldo osservato valido, un saldo sufficiente o un prezzo unitario noto. Verificalo in Account.",
			ws_cancel: "Interrompi",
			api_field_pokemon_name: "Nome del Pokémon",
			api_field_owner: "Proprietario",
			api_field_repo: "Repository",
			api_field_state: "Stato",
			api_field_page: "Pagina",
			api_field_per_page: "Per pagina",
			api_field_indicator: "Indicatore",
			api_field_format: "Formato",
			api_op_get_public_repository_issues: "Ottieni issue del repository pubblico",
			api_op_get_public_repository_pulls: "Ottieni pull del repository pubblico",
			api_op_get_pokemon: "Ottieni Pokémon",
			api_op_get_country_indicator: "Ottieni indicatore del paese",
			api_op_get_apod: "Immagine astronomica del giorno",
			repoUrl: "URL del repository",
			recipe_param_repoUrl: "URL del repository",
			ws_cancelled_note: "Interrotto. Viene mostrato l’ultimo stato salvato.",
			ws_evidence: "Prove consultate",
			ws_evidence_consulted: "consultata il {date}",
			ws_evidence_not_retrieved: "non recuperata",
			ws_evidence_empty: "Nessuna fonte ancora consultata.",
			ws_result: "Risultato",
			ws_delete_confirm: "Eliminare definitivamente questo progetto, rapporti e cronologia? I file esportati e gli originali importati restano.",
			ws_import: "Importa il contesto selezionato",
			ws_context: "Contesto per questa esecuzione",
			project_choose_folder: "Scegli una cartella (facoltativo)",
			ws_import_note: "Seleziona messaggi o testi salvati degli allegati da copiare localmente. Se manca il testo, allega nuovamente il file. Gli originali restano. Reimportare apre la copia esistente. Nulla viene eseguito.",
			ws_constraints: "Vincoli (uno per riga)",
			ws_compare: "Confronta con il rapporto precedente (− rimosso, + aggiunto)",
			ws_result_open: "Apri",
			ws_persisted_note: "Salvato nello spazio di lavoro locale. Non è un file esportato.",
			ws_export_folder: "Salva nella cartella del progetto",
			ws_export_download: "Scarica",
			ws_export_done: "Esportato come {name}",
			ws_export_failed: "Esportazione non riuscita. Il report resta salvato nello spazio di lavoro.",
			ws_export_overwrite: "Sovrascrivere {name} nella cartella del progetto?",
			ws_export_no_folder: "Nessuna cartella di progetto concessa in questo browser. Il permesso potrebbe dover essere ripetuto dopo la riapertura.",
			ws_usage_title: "Il tuo uso di questo mese",
			ws_usage_charged: "Addebitato da Uptokey",
			ws_usage_reference: "Valore di riferimento dell’uso",
			ws_usage_reference_note: "Stima alle tariffe pubbliche di riferimento. Non è una fattura né un risparmio confermato.",
			ws_usage_coverage: "Copertura della misurazione",
			ws_usage_coverage_value: "{included} di {observed} chiamate",
			ws_usage_details: "Verifica il calcolo",
			ws_usage_basis_provider: "riportato dal fornitore",
			ws_usage_basis_estimated: "stimato",
			ws_usage_basis_unknown: "base sconosciuta",
			ws_usage_cov_included: "inclusa",
			ws_usage_cov_missing_usage: "senza uso riportato",
			ws_usage_cov_missing_tariff: "senza tariffa",
			ws_usage_cov_not_comparable: "non confrontabile",
			ws_usage_cov_estimated: "uso stimato",
			ws_usage_cov_local_cache: "riutilizzata localmente",
			ws_usage_access_public: "accesso pubblico",
			ws_usage_access_byok: "la tua chiave",
			ws_usage_access_local: "esecuzione locale",
			ws_usage_access_hosted: "accesso ospitato",
			ws_usage_charge_unconfirmed: "Non tutte le chiamate di questo periodo hanno confermato un addebito, quindi il totale resta sconosciuto invece che zero.",
			ws_usage_no_aggregable: "Nessuna chiamata aveva insieme uso riportato e una tariffa corrispondente.",
			ws_usage_cached: "{cached} in cache",
			ws_usage_rate: "{input}/M ingresso · {output}/M uscita",
			ws_usage_reused: "risposta riutilizzata",
			ws_usage_tariff: "tariffa {id} · {checkedAt}",
			ws_usage_byok_note: "L’importo addebitato da Uptokey non è il costo totale: il BYOK può essere fatturato direttamente dal fornitore e un modello locale consuma la tua attrezzatura e la tua energia.",
			ws_usage_units: "{input} ingresso · {output} uscita",
			ws_usage_empty: "Nessuna chiamata misurata in questo periodo.",
			ws_step_pending: "In attesa",
			ws_plan_limits_value: "{steps} passaggi · {calls} chiamate · {tokens} uscita · {seconds}s",
			ws_capability_unavailable: "non eseguibile",
			ws_evidence_note: "Lo snapshot registra ciò che è stato letto in quel momento; non rende vero il contenuto.",
			"workflow.sources.crossref.search.title": "Cerca su Crossref",
			"workflow.sources.crossref.search.description": "Cerca articoli e DOI nel catalogo pubblico di Crossref.",
			"workflow.sources.open-library.search.title": "Cerca su Open Library",
			"workflow.sources.open-library.search.description": "Cerca libri e autori nel catalogo pubblico di Open Library.",
			"workflow.sources.pubmed.search.title": "Cerca su PubMed",
			"workflow.sources.pubmed.search.description": "Cerca letteratura biomedica su PubMed.",
			"workflow.sources.openalex.search.title": "Cerca su OpenAlex",
			"workflow.sources.openalex.search.description": "Cerca lavori accademici nel catalogo pubblico OpenAlex.",
			"workflow.sources.archive.search.title": "Cerca negli archivi",
			"workflow.sources.archive.search.description": "Cerca documenti storici nella fonte d'archivio.",
			"workflow.sources.rss.read.title": "Leggi feed RSS",
			"workflow.sources.rss.read.description": "Recupera voci da un feed RSS o Atom pubblico.",
			"workflow.capabilities.project_write.title": "Scrivi file di progetto",
			"workflow.capabilities.project_write.description": "Crea o modifica file all’interno della cartella autorizzata del progetto.",
			chat_edit: "Modifica",
			chat_regenerate: "Rigenera",
			chat_save_submit: "Salva e invia",
			chat_cancel_edit: "Annulla",
			cap_discovery_title: "Individuazione funzionalità",
			cap_discovery_search_placeholder: "Cerca funzionalità per nome, tag o destinazione...",
			cap_filter_all: "Tutte",
			cap_filter_available: "Disponibili",
			cap_filter_configurable: "Configurabili",
			cap_filter_unavailable: "Non disponibili",
			cap_tier_available: "Disponibile",
			cap_tier_configurable: "Configurabile",
			cap_tier_unavailable: "Non disponibile",
			cap_action_open_form: "Apri modulo",
			cap_action_prepare: "Prepara piano",
			cap_action_configure: "Configura",
			cap_action_unavailable: "Non disponibile",
			cap_action_details: "Dettagli",
			cap_action_hide_details: "Nascondi dettagli",
			cap_action_clear_search: "Cancella ricerca",
			cap_filter_group_label: "Filtra funzionalità per disponibilità",
			cap_label_destination: "Destinazione",
			cap_label_effect: "Effetto",
			cap_label_limits: "Limiti di esecuzione",
			cap_label_tags: "Tag",
			cap_label_schemas: "Schemi di input/output",
			cap_label_retry_class: "Criterio di ripetizione",
			cap_empty_title: "Nessuna funzionalità trovata",
			cap_empty_desc: "Nessuna funzionalità corrisponde alla ricerca o ai filtri attuali.",
			cap_empty_unregistered: "Nessuna funzionalità è stata ancora registrata in questo spazio di lavoro.",
			cap_reason_executable: "Pronta per preparare il piano di esecuzione",
			cap_reason_catalogued: "Catalogata: richiede configurazione aggiuntiva",
			cap_reason_missing_scopes: "Richiede permessi: {scopes}",
			cap_reason_scopes_unknown: "Permessi non confermati; richiede: {scopes}",
			cap_reason_unavailable: "Non eseguibile in questo ambiente",
			cap_reason_incompatible_schema: "Metadati della capacità incompatibili o incompleti",
			cap_reason_unknown: "Metadati del descrittore incompleti o non riconosciuti",
			cap_unknown_title: "Funzionalità: {id}",
			cap_unknown_desc: "Metadati del descrittore non disponibili.",
			cap_effect_read_external: "Lettura esterna",
			cap_effect_write_external: "Scrittura esterna",
			cap_effect_inference: "Inferenza",
			cap_effect_produce_artifact: "Produci artefatto",
			cap_effect_execute_local: "Esegui in locale",
			cap_destination_public: "Pubblica: {id}",
			cap_destination_local: "Locale: {id}",
			cap_destination_provider: "Provider: {id}",
			cap_destination_unknown: "Destinazione: {id}",
			cap_limits: "{steps} passaggi · {calls} chiamate · {tokens} token · {timeout}s",
			cap_results_count: "{count} funzionalità trovate",
			cap_results_sr: "Mostrando {count} funzionalità",
			cx_accounts_title: "Account e permessi",
			cx_connections_loading: "Caricamento delle connessioni…",
			cx_connections_failed: "Impossibile caricare le connessioni. Riprova.",
			cx_connections_retry: "Riprova",
			cx_accounts_sub: "Un provider, più account. Le chiavi restano su questo dispositivo.",
			cx_add_account: "Aggiungi account",
			cx_provider_id: "ID del provider",
			cx_access_mode: "Modalità di accesso",
			cx_get_access: "Ottieni accesso",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "Configura",
			cx_label: "Nome",
			cx_secret: "Chiave",
			cx_secret_hint: "Vuoto annulla.",
			cx_endpoint: "Endpoint",
			cx_models: "Modelli (separati da virgole)",
			cx_add: "Aggiungi",
			cx_save: "Salva",
			cx_test: "Prova",
			cx_test_all: "Prova tutti",
			cx_test_inference: "Prova con chiamate provider",
			cx_testing: "Prova in corso…",
			cx_consent: "Consenti chiamate con tetto",
			cx_cap_usd: "Tetto (USD)",
			cx_cancel: "Annulla",
			cx_revoke: "Revoca",
			cx_confirm_revoke: "Fai di nuovo clic per confermare",
			cx_reconnect: "Riconnetti",
			cx_rename: "Rinomina",
			cx_disable: "Disattiva",
			cx_enable: "Attiva",
			cx_primary: "Imposta principale",
			cx_install: "Scarica",
			cx_model: "Modello",
			cx_size_unknown: "Dimensione non disponibile",
			cx_no_accounts: "Nessun account. Aggiungi il primo per provarlo qui.",
			cx_resume: "Riprendi",
			cx_connect_oauth: "Connetti con {provider}",
			cx_error: "Errore: {type}",
			cx_job_state: "Attività: {state}",
			cx_st_healthy: "Sano",
			cx_st_degraded: "Degradato",
			cx_st_unauthenticated: "Senza chiave",
			cx_st_disabled: "Disattivato",
			cx_st_unconfigured: "Non configurato",
			cx_st_unknown: "Sconosciuto",
			cx_st_expired: "Scaduto",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "Non autorizzato",
			cx_rs_rate_limited: "Limite superato",
			cx_rs_timeout: "Timeout",
			cx_rs_unreachable: "Irraggiungibile",
			cx_rs_skipped: "Ignorato",
			cx_rs_failed: "Non riuscito",
			cap_scope_required: "Richiede permessi",
			cap_no_action_available: "Funzionalità di riferimento: nessun modulo di esecuzione diretta in questo spazio di lavoro",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		ja: {
			ws_embeddings_title: "埋め込み",
			ws_embeddings_description: "接続したモデルでベクトルを作成します。",
			ws_automation_schedule_authorize: "スケジュールを承認",
			ws_automation_schedule_scope: "範囲、回数、有効期限を制限した継続的な許可。",
			ws_automation_channel_resend: "Resendで送信",
			ws_automation_channel_brevo: "Brevoで送信",
			ws_automation_channel_slack: "Slackで送信",
			ws_automation_channel_description: "確認したメッセージを承認後に送信します。",
			classification_semantic_title: "TypeSafeで分類",
			classification_semantic_note: "選択したテキストのみを分析します。結果は操作の許可にはなりません。",
			df_model_plugin: "モデルプラグインへの参照",
			df_plugin_version: "参照先のバージョン",
			df_plugin_hash: "宣言された SHA-256",
			df_plugin_note: "テンプレートで宣言された参照です。プラグインパッケージのインストールやパッケージハッシュの検証は行いません。",
			df_temperature: "温度（temperature）",
			df_top_p: "累積確率（top-p）",
			df_title: "Dify テンプレートをインポート",
			df_profile: "対応範囲：開始 → LLM → 終了、テキスト入力は1つです。ツール、コード、RAG、環境変数、ツールプラグインは対象外です。モデルプラグインへの参照はインストールせずに読み取れます。",
			df_file: "ローカル YAML ファイル",
			df_file_help: "最大 {bytes} バイト。ローカルで読み取り、YAML は保存しません。",
			df_source_model: "テンプレート内のモデル",
			df_target_model: "このプランに設定されたモデル",
			df_mapping: "元のモデルは参考情報です。入力を反映したメッセージは、承認後に設定済みのゲートウェイモデルのみを使用します。",
			df_template: "テンプレート",
			df_max_tokens: "最大出力トークン数",
			df_prepare: "プランを準備",
			df_prepare_note: "入力を反映したテンプレートのメッセージのみを使用します。以前のチャット履歴、添付、調査ソース、現在の下書きは含みません。実行には別途承認が必要です。",
			df_file_error: "空でない .yaml または .yml ファイルを選択してください。上限は {bytes} バイトです。環境ファイルは使用できません。",
			df_invalid: "テンプレートは拒否されました。未対応の機能や設定を含まない、開始 → LLM → 終了の構成を使用してください。",
			df_limit: "ファイルまたは YAML 構造が対応する制限を超えています。",
			df_input_error: "必須テキストを {max} 文字以内で入力し、出力上限を1～4096に設定してください。",
			df_payload_error: "入力を反映したテンプレートがチャットの12,000バイト制限を超えています。テキストまたは入力を短くしてください。",
			df_read_error: "選択したファイルを読み取れませんでした。",
			mu_title: "モデルとクォータ",
			mu_refresh: "更新",
			mu_no_models: "設定済みモデルのデータはありません。",
			mu_provider_scope: "このプロバイダーの設定済みモデルで共有するローカルクォータです。",
			mu_quota_unknown: "クォータの集計情報を取得できません。",
			mu_table_note: "予約量 / 設定されたローカル上限",
			mu_window: "期間",
			mu_reserved_calls: "予約された呼び出し",
			mu_reserved_tokens: "予約されたトークン",
			mu_minute: "現在の分",
			mu_day: "当日",
			mu_reservation_note: "トークンの予約量には推定入力と許可された最大出力が含まれます。実測の使用量ではありません。",
			mu_presented_run: "表示中の実行",
			mu_usage_unknown: "実測の使用量を取得できません。",
			mu_input_tokens: "報告された入力トークン",
			mu_output_tokens: "報告された出力トークン",
			mu_receipt_coverage: "使用量が完全に報告された試行 / この実行の試行",
			mu_subset_note: "数値には報告された測定値のみを含みます。未報告の測定値は不明のままであり、これらの数値は全使用量の合計ではありません。",
			mu_router_usage: "プロキシへの直接呼び出し",
			mu_router_scope: "このプロセスの開始以降に成功した Router の直接応答です。このカウンターはワークスペースのゲートウェイ呼び出しを含まず、永続化されません。",
			mu_with_usage: "使用量が報告された応答",
			mu_without_usage: "使用量が報告されていない応答",
			mu_in_flight: "進行中の応答",
			mu_interrupted: "中断された応答",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "プレビューは省略されています。実行が正常に完了すると、最終成果物で回答全体を確認できます。",
			ws_gateway_reconnect: "再接続してこの作業の状態を確認してください。",
			ws_gateway_payload: "送信するメッセージ",
			ws_gateway_text_only: "テキストのみ：添付ファイルを削除し、検索ソースを選択しないでください。",
			ws_gateway_size: "会話全体を12,000バイト以内にしてください。新しいチャットを開始するか、文章を短くしてください。",
			ws_gateway_title: "チャット",
			ws_gateway_description: "承認後、表示されたメッセージを一度だけ送信します。",
			ws_browser_title: "ローカルページ検査",
			ws_speech_playback_error: "この音声を再生できませんでした。生成が自動的に繰り返されることはありません。",
			ws_image_prepare: "画像を準備",
			ws_video_title: "動画",
			ws_video_limits_value: "{calls} 回の呼び出し · 合計 {seconds} 秒",
			ws_video_description: "送信前に確認してください。利用できる設定は構成されたモデルによって異なります。",
			ws_video_duration: "長さ（秒）",
			ws_video_ratio: "縦横比",
			ws_video_resolution: "解像度",
			ws_video_audio: "音声を生成",
			ws_video_seed: "シード（任意）",
			ws_video_prepare: "動画リクエストを確認",
			ws_video_invalid: "動画の設定を確認するか、再接続してください。",
			ws_video_download: "MP4をダウンロード",
			ws_video_load: "動画を読み込む",
			ws_video_stop_notice: "追跡を停止してもプロバイダーでの生成はキャンセルされません。",
			ws_video_resume: "追跡を再開",
			ws_video_status_pending: "プロバイダーで待機中",
			ws_video_status_in_progress: "プロバイダーで生成中",
			ws_video_status_completed: "プロバイダーで生成完了",
			ws_video_status_failed: "プロバイダーで生成失敗",
			ws_video_status_cancelled: "プロバイダーによりキャンセル",
			ws_video_status_expired: "プロバイダーで期限切れ",
			ws_video_poll_title: "動画を追跡",
			ws_video_poll_description: "別の動画を作成せず、既存のジョブを確認します。",
			ws_video_content_title: "動画を取得",
			ws_video_content_description: "完了した結果をワークスペースにダウンロードします。",
			ws_image_title: "画像",
			ws_image_description: "計画を準備します。承認後にのみ画像を生成します。対応状況はプロバイダーによって異なります。",
			ws_image_prompt: "説明",
			ws_image_count: "画像数",
			ws_image_size: "サイズ (auto または幅x高さ)",
			ws_image_quality: "品質（任意）",
			ws_image_style: "スタイル（任意）",
			ws_image_load: "画像を読み込む",
			ws_image_invalid: "画像を準備または読み込めませんでした。要求と接続を確認してください。",
			ws_image_download: "画像をダウンロード",
			ws_speech_title: "音声を生成",
			ws_speech_description: "承認後、以下に入力したテキストのみを表示されたモデルで音声に変換します。",
			ws_speech_input: "読み上げるテキスト",
			ws_speech_prepare: "音声生成の計画を準備",
			ws_speech_invalid: "UTF-8で12,000バイト以内のテキストを入力してください。",
			ws_speech_result: "生成された音声",
			ws_speech_result_note: "AIが生成した音声です。再生はユーザーの操作で開始します。",
			ws_speech_load: "音声を読み込む",
			ws_speech_loading: "音声を読み込み中…",
			ws_speech_audio_error: "音声の読み込みと検証に失敗しました。もう一度読み込んでください。",
			ws_speech_limits_value: "{calls} 回の生成 · {seconds}秒",
			ws_transcription_title: "音声を文字起こし",
			ws_transcription_description: "承認後、選択した音声を表示中のモデルで確認可能なテキストに文字起こしします。",
			ws_transcription_file: "音声ファイル（MP3）",
			ws_transcription_language: "言語（任意、ISO 639-1）",
			ws_transcription_prepare: "文字起こし計画を準備",
			ws_transcription_invalid: "MP3ファイルを選び、2文字の言語コードを入力するか空欄にしてください。",
			ws_transcription_result: "文字起こし",
			ws_browser_fill_title: "ローカルページの項目を入力",
			ws_browser_fill_description: "承認後、表示された項目に入力してページを記録します。フォームは送信せず、サーバーへの保存は確認されません。",
			ws_browser_fill_field: "項目 {number}",
			ws_browser_fill_label: "項目の正確なラベル",
			ws_browser_fill_value: "値",
			ws_browser_fill_empty: "値を空にすると項目が消去されます。",
			ws_browser_fill_add: "項目を追加",
			ws_browser_fill_prepare: "確認用の計画を準備",
			ws_browser_fill_invalid: "{origin} のURLと、重複しない1～8個のラベル（各200文字以内）を使用してください。値は各2,000文字以内です。リクエスト全体が大きすぎる場合は値を短くしてください。",
			ws_browser_fill_local: "{origin} のみ。ページのスクリプトは無効です。",
			ws_browser_fill_limits_value: "{steps} ステップ · {calls} 回の操作 · {seconds}秒",
			ws_browser_description: "承認後にローカルページを検査します。クリックやフォームの操作は行いません。",
			ws_tools_result_prepare: "この結果を使った回答を準備",
			project_changeset_title: "提案されたファイル変更",
			project_changeset_note: "モデルがこれらの変更を提案しました。プランを承認するまで何も書き込まれません。デーモンが書き込み前にハッシュを確認します。",
			project_apply: "確認して適用",
			project_apply_busy: "準備中…",
			project_apply_started: "プランを承認しました。書き込み実行を開始しました。結果を確認するにはワークスペースを再度開いてください。",
			project_apply_bind_first: "変更を適用する前に、ローカルプロキシ経由でフォルダを紐付けてください。",
			project_apply_unavailable: "このセッションでは変更の適用は利用できません。",
			ws_tools_result_consent: "新しいプランを承認した後にのみ、この結果がモデルに送信されます。",
			ws_tools_enable: "チャットでローカル操作を提案",
			ws_tools_description: "選択したツールによりモデルは操作を提案できます。各操作には個別のプランと承認が必要です。",
			ws_tools_proposal: "操作の提案",
			ws_tools_not_executed: "このメッセージは提案です。操作を準備しても実行されません。実行するには新しいプランを承認してください。",
			ws_tools_prepare: "この操作を準備",
			ws_filesystem_title: "ローカルファイルのメタデータ",
			ws_filesystem_tool: "ツール",
			ws_filesystem_path: "相対パス",
			ws_filesystem_list: "ディレクトリ一覧",
			ws_filesystem_info: "ファイル情報",
			ws_filesystem_description: "設定されたフォルダー内の名前とメタデータのみ。ファイル内容の読み取りや変更は行いません。",
			ws_filesystem_unavailable: "ローカルファイルツールは利用できません。",
			ws_filesystem_invalid: "パスを確認するか再接続してツールを更新し、新しいプランを作成してください。",
			ws_browser_open: "ローカルページを検査",
			ws_composition_open: "条件付きの次のステップ",
			ws_composition_description: "選択したローカル結果で、大文字と小文字を区別して文字列を確認します。一致した場合は別の検査を提案するだけで、改めて承認が必要です。",
			ws_composition_contains: "結果に含まれる文字列",
			ws_composition_next: "このURLの検査を提案",
			ws_composition_check: "条件を確認",
			ws_composition_no_match: "文字列が見つかりません。次の計画は作成されませんでした。",
			ws_composition_ready: "条件に一致しました。承認する前に次の計画を確認してください。",
			ws_composition_review: "この構成は確認が必要です。次のステップは実行されていません。",
			ws_composition_review_plan: "次の計画を確認",
			ws_browser_url: "ローカルページのURL",
			ws_browser_prepare: "検査を準備",
			ws_browser_invalid: "オリジン {origin} の完全なURLを入力してください。検査は承認後にのみ開始します。",
			ws_browser_limits_value: "{steps} ステップ · {calls} 回の検査 · {seconds}秒",
			ws_download_requested: "{name} のダウンロードを要求しました。ブラウザーのダウンロードを確認してください。",
			title: "あなたのAI。確かな情報源。",
			connect: "接続",
			disconnect: "切断",
			connected: "接続済み",
			offline: "オフライン",
			connecting: "接続中…",
			send: "送信",
			stop: "停止",
			placeholder: "質問を入力… @ でモデルや検索ソースを指定できます。",
			hint: "Ctrl+Enter 送信 · Esc 停止 · マイク 音声入力 · @ メンション · 添付ファイル",
			model: "モデル",
			sources: "検索",
			newChat: "新しいチャット",
			empty_title: "あなたのAI。確かな情報源。",
			empty_body: "ローカルプロキシ（127.0.0.1:21435）に接続し、ローカルまたはBYOKモデルを選択して質問してください。必要に応じて @pubmed / @crossref / @open-library を利用できます。APIキーはこの端末から外に出ません。",
			you: "あなた",
			ai: "AI",
			searching: "参考文献を検索中…",
			answering: "考え中…",
			queryLabel: "検索キーワード",
			queryHint: "検索には2文字以上入力してください",
			local: "ローカル",
			cloud: "クラウド BYOK",
			research: "検索",
			connections: "接続先",
			history: "履歴",
			theme: "テーマ",
			theme_dark: "ダーク",
			theme_light: "ライト",
			theme_auto: "自動",
			keys_local: "キーは端末内に保持",
			attach: "ファイルを添付",
			remove: "削除",
			stop_kept: "停止しました — 一部の回答を保持",
			unknown: "不明",
			cost_unknown: "費用: 不明",
			fallback_on: "フォールバック許可済み",
			disabled_zai: "検索専用 / プロキシでブロック中",
			disabled_openalex: "プロキシ未承認",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "オフライン",
			runtime_ok: "接続可能",
			no_local_models: "検出されたローカルモデルはまだありません。",
			no_history: "保存されたチャットはありません。新しく始めるとブラウザ内に保存されます。",
			attach_busy: "ファイルを読み込み中…",
			err_provision: "プロビジョニングに失敗しました — プロキシは 127.0.0.1:21435 で起動していますか？",
			err_request: "リクエスト失敗",
			err_source: "検索ソースの取得に失敗しました",
			err_source_rate: "検索ソースのレート制限です — しばらく待って再試行してください",
			err_capacity: "ローカルリソースが混雑しています — 再試行してください",
			err_invalid: "無効なリクエストです",
			menu: "サイドバーを開く",
			close_menu: "サイドバーを閉じる",
			lang: "言語",
			credits: "残高",
			size_est: "推定サイズ",
			aliases: "ローカルエイリアス",
			discovered: "インストール済みモデル",
			none_source: "AIのみ",
			papers: "論文",
			books: "書籍",
			delete_chat: "削除",
			composer_disabled: "チャットするにはプロキシに接続してください",
			connect_first: "送信するにはプロキシに接続してください",
			more_options: "その他のオプション",
			hide_options: "オプションを隠す",
			new_project: "新規プロジェクト",
			projects: "プロジェクト",
			project_name: "プロジェクト名",
			local_storage: "ローカル保存",
			streaming: "ストリーミング中…",
			mic: "音声入力",
			mic_stop: "音声入力を停止",
			mic_listening: "聞き取り中…",
			mic_unsupported: "このブラウザは音声入力をサポートしていません",
			mic_denied: "マイクの使用許可が拒否されました",
			mic_error: "音声入力エラー",
			sidebar: "サイドバー",
			note_text_read_failed: "テキストファイルを読み込めませんでした — ファイル名のみ。",
			note_pdf_empty: "PDFからテキストを抽出できませんでした（ファイル名のみ）。",
			note_pdf_unavailable: "PDFテキスト抽出不可 — ファイル名のみ添付。",
			note_doc_binary: "未対応形式 — ファイル名のみ（.doc バイナリ）。",
			note_doc_unsupported: "未対応形式 — ファイル名のみ（docx）。",
			note_doc_compressed: "未対応形式 — ファイル名のみ（docx 圧縮）。",
			note_doc_besteffort: "docx抽出テキスト（不完全な場合があります）。",
			note_unsupported_parse: "解析非対応 — ファイル名のみ。",
			note_image_attached: "画像を添付しました（{name}, {size} バイト）。画像対応モデルのみ送信されます。",
			note_image_preview_failed: "画像を添付しました（{name}）— プレビューに失敗。",
			note_audio_attached: "音声を添付しました（{name}, {size} バイト）— 音声文字起こしは行わず、名前とサイズのみ共有されます。",
			note_unsupported_type: "未対応のファイル形式 — ファイル名のみ（{name}）。",
			hint_prefer_local: "ローカル実行を優先",
			hint_local_gemma: "ローカル Gemma モデル",
			hint_local_qwen: "ローカル Qwen モデル",
			hint_auto_route: "自動ルーティング",
			hint_same_as_auto: "uptokey-auto と同じ",
			hint_pubmed: "PubMed 論文",
			hint_crossref: "Crossref DOI",
			hint_open_library: "Open Library 書籍",
			hint_local_model: "ローカルモデル",
			ws_title: "リサーチ作業",
			ws_open: "調べてレポートを作成",
			ws_hide: "作業パネルを隠す",
			ws_unavailable: "ワークスペースの実行はまだ接続されていません。ローカルワークスペースが利用可能になると、計画・手順・根拠・エクスポートがここに表示されます。",
			ws_contract_mismatch: "この作業はこの画面とは異なる契約バージョンを使っています。値が不完全な可能性があります。",
			ws_goal: "この作業で何をしますか？",
			ws_goal_placeholder: "例：ビタミンDと免疫に関する最近のレビュー",
			ws_create: "作業を作成",
			ws_update: "作業を更新",
			ws_save_recipe: "定型作業を保存",
			ws_recipe_saved: "定型作業を保存しました",
			ws_recipe_note: "定型作業はパラメータと手順を保持します。鍵や権限は含まれず、それ自体が実行を許可することはありません。",
			ws_plan: "計画",
			ws_plan_sources: "情報源",
			ws_plan_destination: "データの送信先",
			ws_plan_model: "モデル",
			ws_plan_limits: "上限",
			ws_approve: "許可して実行",
			ws_approval_note: "許可はこの計画に結び付いています。実質的な変更には新しい許可が必要です。",
			ws_state_draft: "下書き",
			ws_state_awaiting_approval: "許可待ち",
			ws_state_ready: "準備完了",
			ws_state_running: "実行中",
			ws_state_succeeded: "完了",
			ws_state_failed: "失敗",
			ws_state_cancelled: "中断",
			ws_state_needs_attention: "確認が必要",
			ws_steps: "手順",
			ws_step_prepared: "準備済み",
			ws_step_dispatched: "送信済み",
			ws_step_succeeded: "完了",
			ws_step_failed: "失敗",
			ws_step_unknown: "結果不明",
			ws_step_unknown_note: "送信しましたが結果は確認できていません。自動では再実行しません。",
			ws_step_account_note: "未送信：連携アカウントに有効な観測残高、十分な残高、または既知の単価がありません。アカウントで確認してください。",
			ws_cancel: "中断する",
			api_field_pokemon_name: "ポケモン名",
			api_field_owner: "オーナー",
			api_field_repo: "リポジトリ",
			api_field_state: "状態",
			api_field_page: "ページ",
			api_field_per_page: "ページ数",
			api_field_indicator: "指標",
			api_field_format: "フォーマット",
			api_op_get_public_repository_issues: "パブリックリポジトリのイシュー取得",
			api_op_get_public_repository_pulls: "パブリックリポジトリのプル取得",
			api_op_get_pokemon: "ポケモン取得",
			api_op_get_country_indicator: "国別指標取得",
			api_op_get_apod: "今日の天文画像",
			repoUrl: "リポジトリ URL",
			recipe_param_repoUrl: "リポジトリ URL",
			ws_cancelled_note: "中断しました。最後に保存された状態を表示しています。",
			ws_evidence: "参照した根拠",
			ws_evidence_consulted: "{date} に参照",
			ws_evidence_not_retrieved: "取得できず",
			ws_evidence_empty: "まだ参照した情報源はありません。",
			ws_result: "結果",
			ws_delete_confirm: "このプロジェクト、レポート、履歴を完全に削除しますか？エクスポートしたファイルとインポート元のデータは保持されます。",
			ws_import: "選択したコンテキストをインポート",
			ws_context: "この実行のコンテキスト",
			project_choose_folder: "フォルダーを選択（任意）",
			ws_import_note: "ローカルにコピーするメッセージや保存済みの添付テキストを選択してください。テキストがない場合はファイルを再添付してください。元のデータは保持され、再インポートは既存のコピーを開きます。実行は行いません。",
			ws_constraints: "制約（1行に1つ）",
			ws_compare: "前のレポートと比較（− 削除、+ 追加）",
			ws_result_open: "開く",
			ws_persisted_note: "ローカルワークスペースに保存済みです。これはエクスポートされたファイルではありません。",
			ws_export_folder: "プロジェクトフォルダに保存",
			ws_export_download: "ダウンロード",
			ws_export_done: "{name} としてエクスポートしました",
			ws_export_failed: "エクスポートに失敗しました。レポートはワークスペースに保存されたままです。",
			ws_export_overwrite: "プロジェクトフォルダの {name} を上書きしますか？",
			ws_export_no_folder: "このブラウザで許可されたプロジェクトフォルダがありません。再度開いた後に許可のやり直しが必要な場合があります。",
			ws_usage_title: "今月の使用状況",
			ws_usage_charged: "Uptokey の請求額",
			ws_usage_reference: "使用量の参考価値",
			ws_usage_reference_note: "公開されている参考料金による見積もりです。請求書でも、確定した節約額でもありません。",
			ws_usage_coverage: "計測のカバー範囲",
			ws_usage_coverage_value: "{observed} 件中 {included} 件",
			ws_usage_details: "計算を確認",
			ws_usage_basis_provider: "プロバイダー報告",
			ws_usage_basis_estimated: "推定",
			ws_usage_basis_unknown: "根拠不明",
			ws_usage_cov_included: "集計対象",
			ws_usage_cov_missing_usage: "使用量の報告なし",
			ws_usage_cov_missing_tariff: "料金なし",
			ws_usage_cov_not_comparable: "比較不可",
			ws_usage_cov_estimated: "推定使用量",
			ws_usage_cov_local_cache: "ローカルで再利用",
			ws_usage_access_public: "公開アクセス",
			ws_usage_access_byok: "ご自身の鍵",
			ws_usage_access_local: "ローカル実行",
			ws_usage_access_hosted: "ホスト型アクセス",
			ws_usage_charge_unconfirmed: "この期間のすべての呼び出しで請求が確認できたわけではないため、合計はゼロではなく不明です。",
			ws_usage_no_aggregable: "使用量の報告と対応する料金の両方がそろった呼び出しはありません。",
			ws_usage_cached: "キャッシュ {cached}",
			ws_usage_rate: "入力 {input}/M · 出力 {output}/M",
			ws_usage_reused: "再利用した回答",
			ws_usage_tariff: "料金 {id} · {checkedAt}",
			ws_usage_byok_note: "Uptokey の請求額は総費用ではありません。BYOK はプロバイダーから直接請求される場合があり、ローカルモデルはご自身の機材と電力を使います。",
			ws_usage_units: "入力 {input} · 出力 {output}",
			ws_usage_empty: "この期間に計測された呼び出しはありません。",
			ws_step_pending: "保留中",
			ws_plan_limits_value: "{steps} 手順 · {calls} 呼び出し · 出力 {tokens} · {seconds}秒",
			ws_capability_unavailable: "実行不可",
			ws_evidence_note: "スナップショットはその時点で読み取った内容を記録するもので、内容が正しいことを保証するものではありません。",
			"workflow.sources.crossref.search.title": "Crossref を検索",
			"workflow.sources.crossref.search.description": "公開されている Crossref のカタログで論文と DOI を検索します。",
			"workflow.sources.open-library.search.title": "Open Library を検索",
			"workflow.sources.open-library.search.description": "公開されている Open Library のカタログで書籍と著者を検索します。",
			"workflow.sources.pubmed.search.title": "PubMed を検索",
			"workflow.sources.pubmed.search.description": "PubMed で生物医学系の文献を検索します。",
			"workflow.sources.openalex.search.title": "OpenAlexを検索",
			"workflow.sources.openalex.search.description": "公開OpenAlexカタログで学術研究を検索します。",
			"workflow.sources.archive.search.title": "アーカイブを検索",
			"workflow.sources.archive.search.description": "アーカイブのソースで歴史的な記録を検索します。",
			"workflow.sources.rss.read.title": "RSSフィードを読む",
			"workflow.sources.rss.read.description": "公開RSSまたはAtomフィードからエントリを取得します。",
			"workflow.capabilities.project_write.title": "プロジェクトファイルを書き込む",
			"workflow.capabilities.project_write.description": "承認されたプロジェクトフォルダ内でファイルを作成または編集します。",
			chat_edit: "編集",
			chat_regenerate: "再生成",
			chat_save_submit: "保存して送信",
			chat_cancel_edit: "キャンセル",
			cap_discovery_title: "機能の探索",
			cap_discovery_search_placeholder: "名前、タグ、宛先で機能を検索...",
			cap_filter_all: "すべて",
			cap_filter_available: "利用可能",
			cap_filter_configurable: "要設定",
			cap_filter_unavailable: "利用不可",
			cap_tier_available: "利用可能",
			cap_tier_configurable: "要設定",
			cap_tier_unavailable: "利用不可",
			cap_action_open_form: "フォームを開く",
			cap_action_prepare: "計画を準備",
			cap_action_configure: "設定",
			cap_action_unavailable: "利用不可",
			cap_action_details: "詳細",
			cap_action_hide_details: "詳細を非表示",
			cap_action_clear_search: "検索をクリア",
			cap_filter_group_label: "利用可能性で機能を絞り込み",
			cap_label_destination: "宛先",
			cap_label_effect: "効果",
			cap_label_limits: "実行制限",
			cap_label_tags: "タグ",
			cap_label_schemas: "入出力スキーマ",
			cap_label_retry_class: "再試行ポリシー",
			cap_empty_title: "機能が見つかりません",
			cap_empty_desc: "現在の検索やフィルターに一致する機能はありません。",
			cap_empty_unregistered: "このワークスペースにはまだ機能が登録されていません。",
			cap_reason_executable: "実行計画を準備可能",
			cap_reason_catalogued: "カタログ登録済み：追加の設定が必要です",
			cap_reason_missing_scopes: "権限が必要です: {scopes}",
			cap_reason_scopes_unknown: "権限未確認：要 {scopes}",
			cap_reason_unavailable: "この環境では実行できません",
			cap_reason_incompatible_schema: "機能のメタデータに互換性がないか、不完全です",
			cap_reason_unknown: "記述子のメタデータが不完全または認識されません",
			cap_unknown_title: "機能: {id}",
			cap_unknown_desc: "記述子のメタデータが利用できません。",
			cap_effect_read_external: "外部読み取り",
			cap_effect_write_external: "外部書き込み",
			cap_effect_inference: "推論",
			cap_effect_produce_artifact: "成果物を生成",
			cap_effect_execute_local: "ローカルで実行",
			cap_destination_public: "パブリック: {id}",
			cap_destination_local: "ローカル: {id}",
			cap_destination_provider: "プロバイダー: {id}",
			cap_destination_unknown: "宛先: {id}",
			cap_limits: "{steps} ステップ · {calls} 回呼び出し · {tokens} トークン · {timeout}秒",
			cap_results_count: "{count} 個の機能が見つかりました",
			cap_results_sr: "{count} 個の機能を表示中",
			cx_accounts_title: "アカウントと権限",
			cx_connections_loading: "接続を読み込み中…",
			cx_connections_failed: "接続を読み込めませんでした。もう一度お試しください。",
			cx_connections_retry: "再試行",
			cx_accounts_sub: "1プロバイダー、複数アカウント。キーはこのデバイスに残ります。",
			cx_add_account: "アカウントを追加",
			cx_provider_id: "プロバイダーID",
			cx_access_mode: "アクセス方式",
			cx_get_access: "アクセスを取得",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "設定",
			cx_label: "名前",
			cx_secret: "キー",
			cx_secret_hint: "空欄でキャンセル。",
			cx_endpoint: "エンドポイント",
			cx_models: "モデル（カンマ区切り）",
			cx_add: "追加",
			cx_save: "保存",
			cx_test: "テスト",
			cx_test_all: "すべてテスト",
			cx_test_inference: "プロバイダー呼び出しでテスト",
			cx_testing: "テスト中…",
			cx_consent: "上限付きの呼び出しを許可",
			cx_cap_usd: "上限（USD）",
			cx_cancel: "キャンセル",
			cx_revoke: "取り消し",
			cx_confirm_revoke: "もう一度クリックして確定",
			cx_reconnect: "再接続",
			cx_rename: "名前を変更",
			cx_disable: "無効化",
			cx_enable: "有効化",
			cx_primary: "プライマリに設定",
			cx_install: "ダウンロード",
			cx_model: "モデル",
			cx_size_unknown: "サイズ不明",
			cx_no_accounts: "アカウントがありません。最初を追加してここでテスト。",
			cx_resume: "再開",
			cx_connect_oauth: "{provider}で接続",
			cx_error: "エラー: {type}",
			cx_job_state: "ジョブ: {state}",
			cx_st_healthy: "正常",
			cx_st_degraded: "低下",
			cx_st_unauthenticated: "キーなし",
			cx_st_disabled: "無効",
			cx_st_unconfigured: "未設定",
			cx_st_unknown: "不明",
			cx_st_expired: "期限切れ",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "未承認",
			cx_rs_rate_limited: "レート制限",
			cx_rs_timeout: "タイムアウト",
			cx_rs_unreachable: "到達不能",
			cx_rs_skipped: "スキップ",
			cx_rs_failed: "失敗",
			cap_scope_required: "必要な権限",
			cap_no_action_available: "参照用機能：このワークスペースに直接実行フォームはありません",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		ko: {
			ws_embeddings_title: "임베딩",
			ws_embeddings_description: "연결된 모델로 벡터를 만듭니다.",
			ws_automation_schedule_authorize: "일정 승인",
			ws_automation_schedule_scope: "범위, 횟수, 유효 기간이 제한된 반복 권한입니다.",
			ws_automation_channel_resend: "Resend로 보내기",
			ws_automation_channel_brevo: "Brevo로 보내기",
			ws_automation_channel_slack: "Slack으로 보내기",
			ws_automation_channel_description: "검토한 메시지를 승인 후 보냅니다.",
			classification_semantic_title: "TypeSafe로 분류",
			classification_semantic_note: "선택한 텍스트만 분석하며, 결과는 작업을 허가하지 않습니다.",
			df_model_plugin: "모델 플러그인 참조",
			df_plugin_version: "참조된 버전",
			df_plugin_hash: "선언된 SHA-256",
			df_plugin_note: "템플릿에 선언된 참조입니다. 플러그인 패키지를 설치하거나 패키지 해시를 검증하지 않습니다.",
			df_temperature: "온도 (temperature)",
			df_top_p: "누적 확률 (top-p)",
			df_title: "Dify 템플릿 가져오기",
			df_profile: "지원 범위: 시작 → LLM → 종료, 텍스트 입력 1개. 도구, 코드, RAG, 환경 변수 및 도구 플러그인은 제외됩니다. 모델 플러그인 참조는 설치 없이 읽을 수 있습니다.",
			df_file: "로컬 YAML 파일",
			df_file_help: "최대 {bytes}바이트. 로컬에서 읽으며 YAML은 저장하지 않습니다.",
			df_source_model: "템플릿의 모델",
			df_target_model: "이 계획에 설정된 모델",
			df_mapping: "원래 모델은 참고용으로 표시됩니다. 입력을 반영한 메시지는 승인 후 설정된 게이트웨이 모델만 사용합니다.",
			df_template: "템플릿",
			df_max_tokens: "최대 출력 토큰",
			df_prepare: "계획 준비",
			df_prepare_note: "입력을 반영한 템플릿 메시지만 사용합니다. 이전 채팅 기록, 첨부 파일, 조사 출처 및 현재 초안은 제외됩니다. 실행에는 별도 승인이 필요합니다.",
			df_file_error: "{bytes}바이트 이하의 비어 있지 않은 .yaml 또는 .yml 파일을 선택하세요. 환경 파일은 허용되지 않습니다.",
			df_invalid: "템플릿이 거부되었습니다. 지원하지 않는 기능이나 설정 없이 시작 → LLM → 종료 구성을 사용하세요.",
			df_limit: "파일 또는 YAML 구조가 지원 한도를 초과합니다.",
			df_input_error: "필수 텍스트를 {max}자 이내로 입력하고 출력 한도를 1~4096으로 설정하세요.",
			df_payload_error: "입력을 반영한 템플릿이 채팅의 12,000바이트 한도를 초과합니다. 텍스트나 입력을 줄이세요.",
			df_read_error: "선택한 파일을 읽을 수 없습니다.",
			mu_title: "모델 및 할당량",
			mu_refresh: "새로 고침",
			mu_no_models: "설정된 모델 데이터가 없습니다.",
			mu_provider_scope: "이 공급자의 설정된 모델들이 공유하는 로컬 할당량입니다.",
			mu_quota_unknown: "할당량 집계 정보를 사용할 수 없습니다.",
			mu_table_note: "예약량 / 설정된 로컬 한도",
			mu_window: "기간",
			mu_reserved_calls: "예약된 호출",
			mu_reserved_tokens: "예약된 토큰",
			mu_minute: "현재 분",
			mu_day: "오늘",
			mu_reservation_note: "토큰 예약량에는 예상 입력과 허용된 최대 출력이 포함됩니다. 측정된 사용량이 아닙니다.",
			mu_presented_run: "표시된 실행",
			mu_usage_unknown: "측정된 사용량을 사용할 수 없습니다.",
			mu_input_tokens: "보고된 입력 토큰",
			mu_output_tokens: "보고된 출력 토큰",
			mu_receipt_coverage: "전체 사용량이 보고된 시도 / 이 실행의 시도",
			mu_subset_note: "수치는 보고된 측정값만 포함합니다. 누락된 측정값은 알 수 없는 상태로 남으며, 이 수치는 전체 사용량의 합계가 아닙니다.",
			mu_router_usage: "프록시 직접 호출",
			mu_router_scope: "이 프로세스 시작 이후 성공한 Router 직접 응답입니다. 이 카운터는 워크스페이스 게이트웨이 호출을 제외하며 영구 저장되지 않습니다.",
			mu_with_usage: "사용량이 보고된 응답",
			mu_without_usage: "사용량이 보고되지 않은 응답",
			mu_in_flight: "진행 중인 응답",
			mu_interrupted: "중단된 응답",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "미리보기가 잘렸습니다. 실행이 성공적으로 완료되면 최종 결과물에서 전체 답변을 볼 수 있습니다.",
			ws_gateway_reconnect: "다시 연결하여 이 작업의 상태를 확인하세요.",
			ws_gateway_payload: "전송할 메시지",
			ws_gateway_text_only: "텍스트만 지원합니다. 첨부 파일을 제거하고 연구 출처를 선택하지 마세요.",
			ws_gateway_size: "전체 대화는 12,000바이트 이내여야 합니다. 새 채팅을 시작하거나 내용을 줄이세요.",
			ws_gateway_title: "채팅",
			ws_gateway_description: "승인 후 표시된 메시지를 한 번만 전송합니다.",
			ws_browser_title: "로컬 페이지 검사",
			ws_speech_playback_error: "이 오디오를 재생할 수 없습니다. 생성은 자동으로 반복되지 않습니다.",
			ws_image_prepare: "이미지 준비",
			ws_video_title: "동영상",
			ws_video_limits_value: "호출 {calls}회 · 총 {seconds}초",
			ws_video_description: "전송 전에 확인하세요. 사용 가능한 설정은 구성된 모델에 따라 다릅니다.",
			ws_video_duration: "길이(초)",
			ws_video_ratio: "화면 비율",
			ws_video_resolution: "해상도",
			ws_video_audio: "오디오 생성",
			ws_video_seed: "시드(선택)",
			ws_video_prepare: "동영상 요청 검토",
			ws_video_invalid: "동영상 설정을 확인하거나 다시 연결하세요.",
			ws_video_download: "MP4 다운로드",
			ws_video_load: "동영상 불러오기",
			ws_video_stop_notice: "추적을 중지해도 공급자의 생성 작업은 취소되지 않습니다.",
			ws_video_resume: "추적 재개",
			ws_video_status_pending: "공급자 대기열에 있음",
			ws_video_status_in_progress: "공급자에서 생성 중",
			ws_video_status_completed: "공급자에서 생성 완료",
			ws_video_status_failed: "공급자에서 생성 실패",
			ws_video_status_cancelled: "공급자가 취소함",
			ws_video_status_expired: "공급자에서 만료됨",
			ws_video_poll_title: "동영상 추적",
			ws_video_poll_description: "새 동영상을 만들지 않고 기존 작업을 조회합니다.",
			ws_video_content_title: "동영상 가져오기",
			ws_video_content_description: "완료된 결과를 작업 공간에 다운로드합니다.",
			ws_image_title: "이미지",
			ws_image_description: "계획을 준비하세요. 승인 후에만 이미지를 생성합니다. 지원 여부는 공급자마다 다릅니다.",
			ws_image_prompt: "설명",
			ws_image_count: "이미지 수",
			ws_image_size: "크기 (auto 또는 너비x높이)",
			ws_image_quality: "품질 (선택)",
			ws_image_style: "스타일 (선택)",
			ws_image_load: "이미지 불러오기",
			ws_image_invalid: "이미지를 준비하거나 불러올 수 없습니다. 요청과 연결을 확인하세요.",
			ws_image_download: "이미지 다운로드",
			ws_speech_title: "음성 생성",
			ws_speech_description: "승인 후 아래에 입력한 텍스트만 표시된 모델을 사용해 음성으로 변환합니다.",
			ws_speech_input: "읽을 텍스트",
			ws_speech_prepare: "음성 계획 준비",
			ws_speech_invalid: "UTF-8 기준 로컬 제한인 12,000바이트 이내의 텍스트를 입력하세요.",
			ws_speech_result: "생성된 오디오",
			ws_speech_result_note: "AI가 생성한 오디오입니다. 재생은 사용자가 선택할 때만 시작됩니다.",
			ws_speech_load: "오디오 불러오기",
			ws_speech_loading: "오디오 불러오는 중…",
			ws_speech_audio_error: "오디오를 불러오고 검증하지 못했습니다. 다시 불러오세요.",
			ws_speech_limits_value: "생성 {calls}회 · {seconds}초",
			ws_transcription_title: "오디오 전사",
			ws_transcription_description: "승인 후 표시된 모델로 선택한 오디오를 검토 가능한 텍스트로 전사합니다.",
			ws_transcription_file: "오디오 파일(MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "언어(선택, ISO 639-1)",
			ws_transcription_prepare: "전사 계획 준비",
			ws_transcription_invalid: "MP3 파일을 선택하고 두 글자 언어 코드를 입력하거나 비워 두세요.",
			ws_transcription_result: "전사",
			ws_browser_fill_title: "로컬 페이지 필드 채우기",
			ws_browser_fill_description: "승인 후 표시된 필드를 채우고 페이지를 기록합니다. 양식을 제출하지 않으며 서버에 저장되었는지는 확인되지 않습니다.",
			ws_browser_fill_field: "필드 {number}",
			ws_browser_fill_label: "정확한 필드 레이블",
			ws_browser_fill_value: "값",
			ws_browser_fill_empty: "빈 값은 필드를 비웁니다.",
			ws_browser_fill_add: "필드 추가",
			ws_browser_fill_prepare: "검토할 계획 준비",
			ws_browser_fill_invalid: "{origin}의 URL과 서로 다른 레이블 1~8개(각 200자 이하)를 사용하세요. 값은 각각 2,000자까지 허용됩니다. 전체 요청이 너무 크면 값을 줄이세요.",
			ws_browser_fill_local: "{origin}만 허용됩니다. 페이지 스크립트는 비활성화됩니다.",
			ws_browser_fill_limits_value: "{steps}단계 · 작업 {calls}회 · {seconds}초",
			ws_browser_description: "승인 후 로컬 페이지를 검사합니다. 클릭하거나 양식을 조작하지 않습니다.",
			ws_tools_result_prepare: "이 결과로 응답 준비",
			project_changeset_title: "제안된 파일 변경",
			project_changeset_note: "모델이 이러한 변경을 제안했습니다. 계획을 승인하기 전에는 아무것도 기록되지 않으며, 데몬이 쓰기 전에 해시를 확인합니다.",
			project_apply: "검토 후 적용",
			project_apply_busy: "준비 중…",
			project_apply_started: "계획이 승인되었습니다. 쓰기 실행이 시작되었습니다. 결과를 보려면 워크스페이스를 다시 여세요.",
			project_apply_bind_first: "변경을 적용하기 전에 로컬 프록시를 통해 폴더를 연결하세요.",
			project_apply_unavailable: "이 세션에서는 변경 적용을 사용할 수 없습니다.",
			ws_tools_result_consent: "새 계획을 승인한 후에만 이 결과가 모델에 전송됩니다.",
			ws_tools_enable: "채팅에서 로컬 작업 제안",
			ws_tools_description: "선택한 도구로 모델이 작업을 제안할 수 있습니다. 각 작업에는 별도 계획과 승인이 필요합니다.",
			ws_tools_proposal: "작업 제안",
			ws_tools_not_executed: "이 메시지는 제안입니다. 작업을 준비해도 실행되지 않습니다. 실행하려면 새 계획을 승인하세요.",
			ws_tools_prepare: "이 작업 준비",
			ws_filesystem_title: "로컬 파일 메타데이터",
			ws_filesystem_tool: "도구",
			ws_filesystem_path: "상대 경로",
			ws_filesystem_list: "디렉터리 목록",
			ws_filesystem_info: "파일 정보",
			ws_filesystem_description: "설정된 폴더의 이름과 메타데이터만 확인합니다. 파일 내용이나 변경은 포함하지 않습니다.",
			ws_filesystem_unavailable: "로컬 파일 도구를 사용할 수 없습니다.",
			ws_filesystem_invalid: "경로를 확인하거나 다시 연결하여 도구를 갱신한 후 새 계획을 준비하세요.",
			ws_browser_open: "로컬 페이지 검사",
			ws_composition_open: "조건부 다음 단계",
			ws_composition_description: "선택한 로컬 결과에서 대소문자를 구분하여 문자열을 확인합니다. 일치하면 다음 검사만 제안하며 별도 승인이 필요합니다.",
			ws_composition_contains: "결과에 포함된 문자열",
			ws_composition_next: "이 URL 검사 제안",
			ws_composition_check: "조건 확인",
			ws_composition_no_match: "문자열을 찾지 못했습니다. 다음 계획이 생성되지 않았습니다.",
			ws_composition_ready: "조건이 일치했습니다. 승인 전에 다음 계획을 검토하세요.",
			ws_composition_review: "이 구성은 검토가 필요합니다. 다음 단계는 실행되지 않았습니다.",
			ws_composition_review_plan: "다음 계획 검토",
			ws_browser_url: "로컬 페이지 URL",
			ws_browser_prepare: "검사 준비",
			ws_browser_invalid: "출처가 {origin}인 전체 URL을 입력하세요. 검사는 승인 후에만 시작됩니다.",
			ws_browser_limits_value: "{steps}단계 · 검사 {calls}회 · {seconds}초",
			ws_download_requested: "{name} 다운로드를 요청했습니다. 브라우저 다운로드를 확인하세요.",
			title: "당신의 AI. 신뢰할 수 있는 출처.",
			connect: "연결",
			disconnect: "연결 해제",
			connected: "연결됨",
			offline: "오프라인",
			connecting: "연결 중…",
			send: "전송",
			stop: "중지",
			placeholder: "무엇이든 물어보세요… @로 모델이나 검색 출처를 지정할 수 있습니다.",
			hint: "Ctrl+Enter 전송 · Esc 중지 · 마이크 받아쓰기 · @ 멘션 · 파일 첨부",
			model: "모델",
			sources: "검색",
			newChat: "새 채팅",
			empty_title: "당신의 AI. 신뢰할 수 있는 출처.",
			empty_body: "로컬 프록시(127.0.0.1:21435)에 연결하고, 로컬 또는 BYOK 모델을 선택한 후 질문하세요. 필요에 따라 @pubmed / @crossref / @open-library를 함께 사용할 수 있습니다. 키는 이 기기 밖으로 나가지 않습니다.",
			you: "나",
			ai: "AI",
			searching: "참고 자료 검색 중…",
			answering: "생각 중…",
			queryLabel: "검색어",
			queryHint: "검색어는 최소 2글자 이상 입력하세요",
			local: "로컬",
			cloud: "클라우드 BYOK",
			research: "검색",
			connections: "연결",
			history: "기록",
			theme: "테마",
			theme_dark: "다크",
			theme_light: "라이트",
			theme_auto: "자동",
			keys_local: "키는 기기에 안전하게 보관됨",
			attach: "파일 첨부",
			remove: "제거",
			stop_kept: "중지됨 — 생성된 일부 답변 유지",
			unknown: "알 수 없음",
			cost_unknown: "비용: 알 수 없음",
			fallback_on: "대체 경로 승인됨",
			disabled_zai: "연구 전용 / 프록시에서 차단됨",
			disabled_openalex: "프록시에서 지원하지 않음",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "오프라인",
			runtime_ok: "연결 가능",
			no_local_models: "아직 감지된 로컬 모델이 없습니다.",
			no_history: "저장된 채팅이 없습니다. 대화를 시작하면 브라우저에 보관됩니다.",
			attach_busy: "파일 읽는 중…",
			err_provision: "클라이언트 등록 실패 — 127.0.0.1:21435에서 프록시가 실행 중인가요?",
			err_request: "요청 실패",
			err_source: "출처 검색 실패",
			err_source_rate: "출처 호출 한도 초과 — 잠시 후 다시 시도하세요",
			err_capacity: "로컬 리소스 사용량 초과 — 다시 시도하세요",
			err_invalid: "잘못된 요청",
			menu: "사이드바 열기",
			close_menu: "사이드바 닫기",
			lang: "언어",
			credits: "잔액",
			size_est: "예상 크기",
			aliases: "로컬 별칭",
			discovered: "설치된 모델",
			none_source: "AI 단독",
			papers: "논문",
			books: "도서",
			delete_chat: "삭제",
			composer_disabled: "대화하려면 프록시에 연결하세요",
			connect_first: "메시지를 보내려면 프록시에 먼저 연결하세요",
			more_options: "추가 옵션",
			hide_options: "옵션 숨기기",
			new_project: "새 프로젝트",
			projects: "프로젝트",
			project_name: "프로젝트 이름",
			local_storage: "로컬에 저장됨",
			streaming: "스트리밍 중…",
			mic: "받아쓰기",
			mic_stop: "받아쓰기 중지",
			mic_listening: "듣고 있는 중…",
			mic_unsupported: "이 브라우저는 음성 인식을 지원하지 않습니다",
			mic_denied: "마이크 권한이 거부되었습니다",
			mic_error: "받아쓰기 실패",
			sidebar: "사이드바",
			note_text_read_failed: "텍스트 파일을 읽을 수 없음 — 파일 이름만 첨부.",
			note_pdf_empty: "PDF에서 텍스트를 추출할 수 없음 (파일 이름만 첨부).",
			note_pdf_unavailable: "PDF 텍스트 추출 불가 — 파일 이름만 전달됨.",
			note_doc_binary: "지원되지 않는 형식 — 파일 이름만 첨부 (.doc 바이너리).",
			note_doc_unsupported: "지원되지 않는 형식 — 파일 이름만 첨부 (docx).",
			note_doc_compressed: "지원되지 않는 형식 — 파일 이름만 첨부 (docx 압축).",
			note_doc_besteffort: "추출된 docx 텍스트 (불완전할 수 있음).",
			note_unsupported_parse: "구문 분석 미지원 — 파일 이름만 첨부.",
			note_image_attached: "이미지 첨부됨 ({name}, {size} 바이트). 이미지 처리가 가능한 모델에만 전송됩니다.",
			note_image_preview_failed: "이미지 첨부됨 ({name}) — 미리보기 실패.",
			note_audio_attached: "오디오 첨부됨 ({name}, {size} 바이트) — 오디오는 전사되지 않으며 이름과 크기만 공유됩니다.",
			note_unsupported_type: "지원되지 않는 파일 형식 — 이름만 첨부 ({name}).",
			hint_prefer_local: "로컬 런타임 우선",
			hint_local_gemma: "로컬 Gemma 모델",
			hint_local_qwen: "로컬 Qwen 모델",
			hint_auto_route: "자동 라우팅",
			hint_same_as_auto: "uptokey-auto와 동일",
			hint_pubmed: "PubMed 논문",
			hint_crossref: "Crossref DOI",
			hint_open_library: "Open Library 도서",
			hint_local_model: "로컬 모델",
			ws_title: "조사 작업",
			ws_open: "조사하고 보고서 만들기",
			ws_hide: "작업 패널 숨기기",
			ws_unavailable: "워크스페이스 실행이 아직 연결되지 않았습니다. 로컬 워크스페이스를 사용할 수 있게 되면 계획, 단계, 근거, 내보내기가 여기에 표시됩니다.",
			ws_contract_mismatch: "이 작업은 이 화면과 다른 계약 버전을 사용합니다. 값이 불완전할 수 있습니다.",
			ws_goal: "이 작업으로 무엇을 하시겠습니까?",
			ws_goal_placeholder: "예: 비타민 D와 면역에 관한 최근 리뷰",
			ws_create: "작업 만들기",
			ws_update: "작업 업데이트",
			ws_save_recipe: "루틴 저장",
			ws_recipe_saved: "루틴이 저장되었습니다",
			ws_recipe_note: "루틴은 매개변수와 단계를 보관합니다. 키나 권한은 포함하지 않으며 그 자체로 실행을 허가하지 않습니다.",
			ws_plan: "계획",
			ws_plan_sources: "출처",
			ws_plan_destination: "데이터 전송 대상",
			ws_plan_model: "모델",
			ws_plan_limits: "한도",
			ws_approve: "승인하고 실행",
			ws_approval_note: "승인은 이 계획에 묶여 있습니다. 실질적인 변경에는 새 승인이 필요합니다.",
			ws_state_draft: "초안",
			ws_state_awaiting_approval: "승인 대기 중",
			ws_state_ready: "준비됨",
			ws_state_running: "실행 중",
			ws_state_succeeded: "완료됨",
			ws_state_failed: "실패",
			ws_state_cancelled: "중단됨",
			ws_state_needs_attention: "확인 필요",
			ws_steps: "단계",
			ws_step_prepared: "준비됨",
			ws_step_dispatched: "전송됨",
			ws_step_succeeded: "완료",
			ws_step_failed: "실패",
			ws_step_unknown: "결과 알 수 없음",
			ws_step_unknown_note: "전송되었으나 결과가 확인되지 않았습니다. 자동으로 다시 실행하지 않습니다.",
			ws_step_account_note: "전송되지 않음: 연결된 계정에 유효한 관측 잔액, 충분한 잔액 또는 알려진 단가가 없습니다. 계정에서 확인하세요.",
			ws_cancel: "중단",
			api_field_pokemon_name: "포켓몬 이름",
			api_field_owner: "소유자",
			api_field_repo: "레포지토리",
			api_field_state: "상태",
			api_field_page: "페이지",
			api_field_per_page: "페이지당",
			api_field_indicator: "지표",
			api_field_format: "포맷",
			api_op_get_public_repository_issues: "공개 레포지토리 이슈 가져오기",
			api_op_get_public_repository_pulls: "공개 레포지토리 풀 가져오기",
			api_op_get_pokemon: "포켓몬 가져오기",
			api_op_get_country_indicator: "국가 지표 가져오기",
			api_op_get_apod: "오늘의 천문 사진",
			repoUrl: "리포지토리 URL",
			recipe_param_repoUrl: "리포지토리 URL",
			ws_cancelled_note: "중단되었습니다. 마지막으로 저장된 상태를 표시합니다.",
			ws_evidence: "확인한 근거",
			ws_evidence_consulted: "{date} 확인",
			ws_evidence_not_retrieved: "가져오지 못함",
			ws_evidence_empty: "아직 확인한 출처가 없습니다.",
			ws_result: "결과",
			ws_delete_confirm: "이 프로젝트, 보고서 및 기록을 영구 삭제할까요? 내보낸 파일과 가져온 원본은 유지됩니다.",
			ws_import: "선택한 컨텍스트 가져오기",
			ws_context: "이번 실행의 컨텍스트",
			project_choose_folder: "폴더 선택 (선택 사항)",
			ws_import_note: "로컬에 복사할 메시지나 저장된 첨부 텍스트를 선택하세요. 텍스트가 없으면 파일을 다시 첨부하세요. 원본은 유지되며 다시 가져오면 기존 사본을 엽니다. 실행하지 않습니다.",
			ws_constraints: "제약 조건 (한 줄에 하나)",
			ws_compare: "이전 보고서와 비교 (− 삭제, + 추가)",
			ws_result_open: "열기",
			ws_persisted_note: "로컬 워크스페이스에 저장되었습니다. 내보낸 파일이 아닙니다.",
			ws_export_folder: "프로젝트 폴더에 저장",
			ws_export_download: "다운로드",
			ws_export_done: "{name}(으)로 내보냈습니다",
			ws_export_failed: "내보내기에 실패했습니다. 보고서는 워크스페이스에 그대로 저장되어 있습니다.",
			ws_export_overwrite: "프로젝트 폴더의 {name}을(를) 덮어쓸까요?",
			ws_export_no_folder: "이 브라우저에 허용된 프로젝트 폴더가 없습니다. 다시 연 뒤에 권한을 새로 부여해야 할 수 있습니다.",
			ws_usage_title: "이번 달 사용량",
			ws_usage_charged: "Uptokey 청구액",
			ws_usage_reference: "사용량의 참고 가치",
			ws_usage_reference_note: "공개된 참고 요금 기준 추정치입니다. 청구서도 아니고 확정된 절감액도 아닙니다.",
			ws_usage_coverage: "측정 범위",
			ws_usage_coverage_value: "{observed}건 중 {included}건",
			ws_usage_details: "계산 확인",
			ws_usage_basis_provider: "제공자 보고",
			ws_usage_basis_estimated: "추정",
			ws_usage_basis_unknown: "근거 불명",
			ws_usage_cov_included: "집계 포함",
			ws_usage_cov_missing_usage: "사용량 미보고",
			ws_usage_cov_missing_tariff: "요금 없음",
			ws_usage_cov_not_comparable: "비교 불가",
			ws_usage_cov_estimated: "추정 사용량",
			ws_usage_cov_local_cache: "로컬에서 재사용",
			ws_usage_access_public: "공개 이용",
			ws_usage_access_byok: "본인 키",
			ws_usage_access_local: "로컬 실행",
			ws_usage_access_hosted: "호스팅 이용",
			ws_usage_charge_unconfirmed: "이 기간의 모든 호출이 청구를 확인한 것은 아니므로 합계는 0이 아니라 알 수 없음입니다.",
			ws_usage_no_aggregable: "사용량 보고와 해당 요금을 모두 갖춘 호출이 없습니다.",
			ws_usage_cached: "캐시 {cached}",
			ws_usage_rate: "입력 {input}/M · 출력 {output}/M",
			ws_usage_reused: "재사용된 답변",
			ws_usage_tariff: "요금 {id} · {checkedAt}",
			ws_usage_byok_note: "Uptokey 청구액이 총비용은 아닙니다. BYOK는 제공자가 직접 청구할 수 있고, 로컬 모델은 사용자의 장비와 전력을 사용합니다.",
			ws_usage_units: "입력 {input} · 출력 {output}",
			ws_usage_empty: "이 기간에 측정된 호출이 없습니다.",
			ws_step_pending: "대기 중",
			ws_plan_limits_value: "{steps}단계 · {calls}회 호출 · 출력 {tokens} · {seconds}초",
			ws_capability_unavailable: "실행 불가",
			ws_evidence_note: "스냅샷은 그 시점에 읽은 내용을 기록할 뿐, 내용이 사실임을 보장하지 않습니다.",
			"workflow.sources.crossref.search.title": "Crossref 검색",
			"workflow.sources.crossref.search.description": "공개된 Crossref 목록에서 논문과 DOI를 찾습니다.",
			"workflow.sources.open-library.search.title": "Open Library 검색",
			"workflow.sources.open-library.search.description": "공개된 Open Library 목록에서 도서와 저자를 찾습니다.",
			"workflow.sources.pubmed.search.title": "PubMed 검색",
			"workflow.sources.pubmed.search.description": "PubMed에서 생의학 문헌을 찾습니다.",
			"workflow.sources.openalex.search.title": "OpenAlex 검색",
			"workflow.sources.openalex.search.description": "공개 OpenAlex 카탈로그에서 학술 연구를 찾습니다.",
			"workflow.sources.archive.search.title": "아카이브 검색",
			"workflow.sources.archive.search.description": "아카이브 출처에서 역사 기록을 찾습니다.",
			"workflow.sources.rss.read.title": "RSS 피드 읽기",
			"workflow.sources.rss.read.description": "공개 RSS 또는 Atom 피드에서 항목을 가져옵니다.",
			"workflow.capabilities.project_write.title": "프로젝트 파일 쓰기",
			"workflow.capabilities.project_write.description": "승인된 프로젝트 폴더 내에서 파일을 생성하거나 편집합니다.",
			chat_edit: "수정",
			chat_regenerate: "다시 생성",
			chat_save_submit: "저장 후 전송",
			chat_cancel_edit: "취소",
			cap_discovery_title: "기능 탐색",
			cap_discovery_search_placeholder: "이름, 태그 또는 대상으로 기능 검색...",
			cap_filter_all: "전체",
			cap_filter_available: "사용 가능",
			cap_filter_configurable: "설정 필요",
			cap_filter_unavailable: "사용 불가",
			cap_tier_available: "사용 가능",
			cap_tier_configurable: "설정 필요",
			cap_tier_unavailable: "사용 불가",
			cap_action_open_form: "양식 열기",
			cap_action_prepare: "계획 준비",
			cap_action_configure: "설정",
			cap_action_unavailable: "사용 불가",
			cap_action_details: "세부 정보",
			cap_action_hide_details: "세부 정보 숨기기",
			cap_action_clear_search: "검색 지우기",
			cap_filter_group_label: "가용성별 기능 필터링",
			cap_label_destination: "대상",
			cap_label_effect: "효과",
			cap_label_limits: "실행 제한",
			cap_label_tags: "태그",
			cap_label_schemas: "입출력 스키마",
			cap_label_retry_class: "재시도 정책",
			cap_empty_title: "기능을 찾을 수 없음",
			cap_empty_desc: "현재 검색이나 필터와 일치하는 기능이 없습니다.",
			cap_empty_unregistered: "이 워크스페이스에 아직 등록된 기능이 없습니다.",
			cap_reason_executable: "실행 계획 준비 가능",
			cap_reason_catalogued: "카탈로그 등록됨: 추가 설정 필요",
			cap_reason_missing_scopes: "권한 필요: {scopes}",
			cap_reason_scopes_unknown: "권한 미확인; 필요: {scopes}",
			cap_reason_unavailable: "이 환경에서 실행할 수 없음",
			cap_reason_incompatible_schema: "기능 메타데이터가 호환되지 않거나 불완전합니다",
			cap_reason_unknown: "설명자 메타데이터가 불완전하거나 인식되지 않음",
			cap_unknown_title: "기능: {id}",
			cap_unknown_desc: "설명자 메타데이터를 사용할 수 없습니다.",
			cap_effect_read_external: "외부 읽기",
			cap_effect_write_external: "외부 쓰기",
			cap_effect_inference: "추론",
			cap_effect_produce_artifact: "결과물 생성",
			cap_effect_execute_local: "로컬에서 실행",
			cap_destination_public: "공개 소스: {id}",
			cap_destination_local: "로컬: {id}",
			cap_destination_provider: "공급자: {id}",
			cap_destination_unknown: "대상: {id}",
			cap_limits: "{steps} 단계 · {calls} 호출 · {tokens} 토큰 · {timeout}초",
			cap_results_count: "{count}개 기능 발견",
			cap_results_sr: "{count}개 기능 표시 중",
			cx_accounts_title: "계정 및 권한",
			cx_connections_loading: "연결을 불러오는 중…",
			cx_connections_failed: "연결을 불러올 수 없습니다. 다시 시도해 주세요.",
			cx_connections_retry: "다시 시도",
			cx_accounts_sub: "제공자 하나, 여러 계정. 키는 이 기기에 남습니다.",
			cx_add_account: "계정 추가",
			cx_provider_id: "제공자 ID",
			cx_access_mode: "접근 방식",
			cx_get_access: "접근 권한 받기",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "구성",
			cx_label: "이름",
			cx_secret: "키",
			cx_secret_hint: "비워 두면 취소됩니다.",
			cx_endpoint: "엔드포인트",
			cx_models: "모델(쉼표로 구분)",
			cx_add: "추가",
			cx_save: "저장",
			cx_test: "테스트",
			cx_test_all: "모두 테스트",
			cx_test_inference: "제공자 호출로 테스트",
			cx_testing: "테스트 중…",
			cx_consent: "상한이 있는 호출 허용",
			cx_cap_usd: "상한(USD)",
			cx_cancel: "취소",
			cx_revoke: "해지",
			cx_confirm_revoke: "다시 클릭하여 확인",
			cx_reconnect: "다시 연결",
			cx_rename: "이름 바꾸기",
			cx_disable: "사용 안 함",
			cx_enable: "사용",
			cx_primary: "기본으로 설정",
			cx_install: "다운로드",
			cx_model: "모델",
			cx_size_unknown: "크기를 알 수 없음",
			cx_no_accounts: "계정이 없습니다. 첫 계정을 추가하여 여기서 테스트하세요.",
			cx_resume: "다시 시작",
			cx_connect_oauth: "{provider}로 연결",
			cx_error: "오류: {type}",
			cx_job_state: "작업: {state}",
			cx_st_healthy: "정상",
			cx_st_degraded: "저하됨",
			cx_st_unauthenticated: "키 없음",
			cx_st_disabled: "사용 안 함",
			cx_st_unconfigured: "구성되지 않음",
			cx_st_unknown: "알 수 없음",
			cx_st_expired: "만료됨",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "승인되지 않음",
			cx_rs_rate_limited: "속도 제한",
			cx_rs_timeout: "시간 초과",
			cx_rs_unreachable: "도달 불가",
			cx_rs_skipped: "건너뜀",
			cx_rs_failed: "실패",
			cap_scope_required: "필요 권한",
			cap_no_action_available: "참조 기능: 이 워크스페이스에 직접 실행 양식이 없음",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		"zh-CN": {
			ws_embeddings_title: "嵌入向量",
			ws_embeddings_description: "使用已连接的模型生成向量。",
			ws_automation_schedule_authorize: "授权计划",
			ws_automation_schedule_scope: "按范围、次数和有效期限制的重复执行权限。",
			ws_automation_channel_resend: "通过Resend发送",
			ws_automation_channel_brevo: "通过Brevo发送",
			ws_automation_channel_slack: "通过Slack发送",
			ws_automation_channel_description: "授权后发送已审核的消息。",
			classification_semantic_title: "使用TypeSafe分类",
			classification_semantic_note: "仅分析所选文本；分类结果不授予操作权限。",
			df_model_plugin: "模型插件引用",
			df_plugin_version: "引用版本",
			df_plugin_hash: "声明的 SHA-256",
			df_plugin_note: "模板中声明的引用。不安装插件包，也不验证插件包的哈希值。",
			df_temperature: "温度（temperature）",
			df_top_p: "累积概率（top-p）",
			df_title: "导入 Dify 模板",
			df_profile: "支持范围：开始 → LLM → 结束，包含一个文本输入。工具、代码、RAG、环境变量和工具插件不在此范围内。可在不安装的情况下读取模型插件引用。",
			df_file: "本地 YAML 文件",
			df_file_help: "最多 {bytes} 字节。在本地读取，不保存 YAML。",
			df_source_model: "模板中的模型",
			df_target_model: "此计划配置的模型",
			df_mapping: "原始模型仅供参考。填充后的消息仅在批准后使用已配置的网关模型。",
			df_template: "模板",
			df_max_tokens: "最大输出 token 数",
			df_prepare: "准备计划",
			df_prepare_note: "仅使用填充后的模板消息。不会包含以前的聊天记录、附件、研究来源或当前草稿。执行需要单独批准。",
			df_file_error: "请选择非空且不超过 {bytes} 字节的 .yaml 或 .yml 文件。不接受环境文件。",
			df_invalid: "模板已拒绝。请使用不含不支持的功能或设置的开始 → LLM → 结束流程。",
			df_limit: "文件或 YAML 结构超出支持的限制。",
			df_input_error: "请输入不超过 {max} 个字符的必填文本，并将输出上限设为 1 至 4096。",
			df_payload_error: "填充后的模板超出聊天的 12,000 字节限制。请缩短文本或输入。",
			df_read_error: "无法读取所选文件。",
			mu_title: "模型与配额",
			mu_refresh: "刷新",
			mu_no_models: "没有已配置模型的数据。",
			mu_provider_scope: "此提供商的已配置模型共享本地配额。",
			mu_quota_unknown: "配额统计不可用。",
			mu_table_note: "预留量 / 已配置的本地上限",
			mu_window: "时段",
			mu_reserved_calls: "预留调用次数",
			mu_reserved_tokens: "预留 token 数",
			mu_minute: "当前分钟",
			mu_day: "当天",
			mu_reservation_note: "预留 token 包括估算的输入量和允许的最大输出量，不代表实测用量。",
			mu_presented_run: "当前显示的执行",
			mu_usage_unknown: "实测用量不可用。",
			mu_input_tokens: "已报告的输入 token",
			mu_output_tokens: "已报告的输出 token",
			mu_receipt_coverage: "完整报告用量的尝试 / 本次执行的尝试",
			mu_subset_note: "数值仅包含已报告的测量值。缺失的测量值仍为未知；这些数值不代表全部用量。",
			mu_router_usage: "直接代理调用",
			mu_router_scope: "自本进程启动以来成功的 Router 直接响应。此计数器不包含工作区网关调用，且不会持久保存。",
			mu_with_usage: "已报告用量的响应",
			mu_without_usage: "未报告用量的响应",
			mu_in_flight: "进行中的响应",
			mu_interrupted: "已中断的响应",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "预览已截断。执行成功后，可在最终产物中查看完整回答。",
			ws_gateway_reconnect: "请重新连接以查看此任务的状态。",
			ws_gateway_payload: "将发送的消息",
			ws_gateway_text_only: "仅支持文本：请移除附件，并取消选择研究来源。",
			ws_gateway_size: "完整对话不得超过12,000字节。请开始新聊天或缩短文本。",
			ws_gateway_title: "对话",
			ws_gateway_description: "批准后仅发送一次所显示的消息。",
			ws_browser_title: "本地页面检查",
			ws_speech_playback_error: "无法播放此音频。不会自动重新生成。",
			ws_image_prepare: "准备图像",
			ws_video_title: "视频",
			ws_video_limits_value: "{calls} 次调用 · 共 {seconds} 秒",
			ws_video_description: "发送前请检查。可用设置取决于已配置的模型。",
			ws_video_duration: "时长（秒）",
			ws_video_ratio: "宽高比",
			ws_video_resolution: "分辨率",
			ws_video_audio: "生成音频",
			ws_video_seed: "种子（可选）",
			ws_video_prepare: "检查视频请求",
			ws_video_invalid: "请检查视频设置或重新连接。",
			ws_video_download: "下载 MP4",
			ws_video_load: "加载视频",
			ws_video_stop_notice: "停止跟踪不会取消提供商的生成任务。",
			ws_video_resume: "恢复跟踪",
			ws_video_status_pending: "提供商队列中",
			ws_video_status_in_progress: "提供商正在生成",
			ws_video_status_completed: "提供商已完成生成",
			ws_video_status_failed: "提供商生成失败",
			ws_video_status_cancelled: "提供商已取消",
			ws_video_status_expired: "提供商任务已过期",
			ws_video_poll_title: "跟踪视频",
			ws_video_poll_description: "查询已知任务，不创建另一个视频。",
			ws_video_content_title: "获取视频",
			ws_video_content_description: "将已完成的结果下载到工作区。",
			ws_image_title: "图像",
			ws_image_description: "准备计划；仅在授权后生成图像。支持情况因提供商而异。",
			ws_image_prompt: "描述",
			ws_image_count: "图像数量",
			ws_image_size: "尺寸（auto 或宽x高）",
			ws_image_quality: "质量（可选）",
			ws_image_style: "样式（可选）",
			ws_image_load: "加载图像",
			ws_image_invalid: "无法准备或加载图像。请检查请求和连接。",
			ws_image_download: "下载图像",
			ws_speech_title: "生成语音",
			ws_speech_description: "批准后，仅使用显示的模型将下方输入的文本转换为音频。",
			ws_speech_input: "要朗读的文本",
			ws_speech_prepare: "准备语音计划",
			ws_speech_invalid: "请输入文本，并控制在本地限制的 12,000 个 UTF-8 字节以内。",
			ws_speech_result: "生成的音频",
			ws_speech_result_note: "由 AI 生成的音频。仅在你选择播放时开始播放。",
			ws_speech_load: "加载音频",
			ws_speech_loading: "正在加载音频…",
			ws_speech_audio_error: "无法加载并验证音频，请尝试重新加载。",
			ws_speech_limits_value: "生成 {calls} 次 · {seconds}秒",
			ws_transcription_title: "转录音频",
			ws_transcription_description: "批准后，使用所示模型将所选音频转录为可审阅的文本。",
			ws_transcription_file: "音频文件（MP3）",
			ws_transcription_language: "语言（可选，ISO 639-1）",
			ws_transcription_prepare: "准备转录计划",
			ws_transcription_invalid: "请选择 MP3 文件并输入两位语言代码，或留空。",
			ws_transcription_result: "转录",
			ws_browser_fill_title: "填写本地页面字段",
			ws_browser_fill_description: "批准后填写所示字段并记录页面。不会提交表单，也不确认数据已保存到服务器。",
			ws_browser_fill_field: "字段 {number}",
			ws_browser_fill_label: "字段的准确标签",
			ws_browser_fill_value: "值",
			ws_browser_fill_empty: "空值会清空字段。",
			ws_browser_fill_add: "添加字段",
			ws_browser_fill_prepare: "准备待审核计划",
			ws_browser_fill_invalid: "请使用来源为 {origin} 的 URL 和 1–8 个不同的标签（每个最多 200 字符）。每个值最多 2,000 字符；若整个请求过大，请缩短这些值。",
			ws_browser_fill_local: "仅限 {origin}。页面脚本已禁用。",
			ws_browser_fill_limits_value: "{steps} 个步骤 · {calls} 次操作 · {seconds}秒",
			ws_browser_description: "批准后检查本地页面，不执行点击或表单操作。",
			ws_tools_result_prepare: "用此结果准备回复",
			project_changeset_title: "建议的文件更改",
			project_changeset_note: "模型提出了这些更改。在您批准计划之前不会写入任何内容；守护进程会在写入前校验哈希。",
			project_apply: "审核并应用",
			project_apply_busy: "准备中…",
			project_apply_started: "计划已批准。写入运行已启动；请重新打开工作区查看结果。",
			project_apply_bind_first: "在应用更改之前，请通过本地代理绑定文件夹。",
			project_apply_unavailable: "本次会话中无法应用更改。",
			ws_tools_result_consent: "只有在您批准新计划后，此结果才会发送给模型。",
			ws_tools_enable: "在聊天中建议本地操作",
			ws_tools_description: "所选工具允许模型提出操作建议。每个操作都需要单独的计划和您的批准。",
			ws_tools_proposal: "操作建议",
			ws_tools_not_executed: "这条消息是一项建议。准备操作不会执行操作；请批准新计划后再执行。",
			ws_tools_prepare: "准备此操作",
			ws_filesystem_title: "本地文件元数据",
			ws_filesystem_tool: "工具",
			ws_filesystem_path: "相对路径",
			ws_filesystem_list: "列出目录",
			ws_filesystem_info: "文件信息",
			ws_filesystem_description: "仅限已配置文件夹中的名称和元数据。不读取文件内容或修改文件。",
			ws_filesystem_unavailable: "本地文件工具不可用。",
			ws_filesystem_invalid: "检查路径或重新连接以刷新工具，然后准备新计划。",
			ws_browser_open: "检查本地页面",
			ws_composition_open: "有条件的下一步",
			ws_composition_description: "在所选本地结果中检查区分大小写的字面文本。匹配时仅提出另一次检查，执行仍需单独批准。",
			ws_composition_contains: "如果结果包含",
			ws_composition_next: "提议检查此网址",
			ws_composition_check: "检查条件",
			ws_composition_no_match: "未找到文本。未创建后续计划。",
			ws_composition_ready: "条件已匹配。请在批准前审阅下一计划。",
			ws_composition_review: "此组合需要审阅。未执行下一步。",
			ws_composition_review_plan: "审阅下一计划",
			ws_browser_url: "本地页面 URL",
			ws_browser_prepare: "准备检查",
			ws_browser_invalid: "请输入来源为 {origin} 的完整 URL。只有批准后才会开始检查。",
			ws_browser_limits_value: "{steps} 个步骤 · {calls} 次检查 · {seconds}秒",
			ws_download_requested: "已请求下载 {name}。请检查浏览器下载列表。",
			title: "你的 AI，真实来源。",
			connect: "连接",
			disconnect: "断开连接",
			connected: "已连接",
			offline: "离线",
			connecting: "正在连接…",
			send: "发送",
			stop: "停止",
			placeholder: "提出任何问题… 使用 @ 选择模型或研究文献来源。",
			hint: "Ctrl+Enter 发送 · Esc 停止 · 麦克风 听写 · @ 提及 · 附件",
			model: "模型",
			sources: "研究",
			newChat: "新对话",
			empty_title: "你的 AI，真实来源。",
			empty_body: "连接到本地代理（127.0.0.1:21435），选择本地模型或 BYOK 密钥，可选搭配 @pubmed / @crossref / @open-library，然后提问。密钥仅保存在本机设备上。",
			you: "你",
			ai: "AI",
			searching: "正在检索参考文献…",
			answering: "正在思考…",
			queryLabel: "检索词",
			queryHint: "至少输入 2 个字符以检索",
			local: "本地",
			cloud: "云端 BYOK",
			research: "研究",
			connections: "连接",
			history: "历史记录",
			theme: "主题",
			theme_dark: "深色",
			theme_light: "浅色",
			theme_auto: "自动",
			keys_local: "密钥保留在本设备上",
			attach: "附加文件",
			remove: "移除",
			stop_kept: "已停止 — 保留已生成的部分回答",
			unknown: "未知",
			cost_unknown: "费用: 未知",
			fallback_on: "已启用备用容灾",
			disabled_zai: "仅供检索 / 在代理中受限",
			disabled_openalex: "代理暂未准入",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "离线",
			runtime_ok: "可用",
			no_local_models: "尚未发现本地模型。",
			no_history: "暂无保存的对话。开启新对话即可保存在本地浏览器中。",
			attach_busy: "正在读取文件…",
			err_provision: "注册客户端失败 — 代理是否运行在 127.0.0.1:21435？",
			err_request: "请求失败",
			err_source: "源检索失败",
			err_source_rate: "检索源请求受限 — 请稍后重试",
			err_capacity: "本地资源繁忙 — 请重试",
			err_invalid: "无效的请求",
			menu: "打开侧边栏",
			close_menu: "关闭侧边栏",
			lang: "语言",
			credits: "额度",
			size_est: "估算大小",
			aliases: "本地别名",
			discovered: "已安装模型",
			none_source: "纯 AI",
			papers: "论文",
			books: "图书",
			delete_chat: "删除",
			composer_disabled: "请连接本地代理以开始聊天",
			connect_first: "请连接本地代理后再发送消息",
			more_options: "更多选项",
			hide_options: "收起选项",
			new_project: "新建项目",
			projects: "项目",
			project_name: "项目名称",
			local_storage: "本地存储",
			streaming: "正在生成…",
			mic: "语音听写",
			mic_stop: "停止听写",
			mic_listening: "正在聆听…",
			mic_unsupported: "当前浏览器不支持语音听写",
			mic_denied: "麦克风权限已被拒绝",
			mic_error: "语音听写失败",
			sidebar: "侧边栏",
			note_text_read_failed: "无法读取文本文件 — 仅保留文件名。",
			note_pdf_empty: "PDF 未包含可提取的文本（仅保留文件名）。",
			note_pdf_unavailable: "无法提取 PDF 文本 — 仅附加文件名。",
			note_doc_binary: "格式不支持解析 — 仅保留文件名 (.doc 二进制)。",
			note_doc_unsupported: "格式不支持解析 — 仅保留文件名 (docx)。",
			note_doc_compressed: "格式不支持解析 — 仅保留文件名 (docx 压缩)。",
			note_doc_besteffort: "近似提取的 docx 文本（可能不完整）。",
			note_unsupported_parse: "不支持解析 — 仅保留文件名。",
			note_image_attached: "已附加图片（{name}，{size} 字节）。仅在模型确认支持视觉时发送。",
			note_image_preview_failed: "已附加图片（{name}）— 预览生成失败。",
			note_audio_attached: "已附加音频（{name}，{size} 字节）— 本端不提供音频转录，仅共享文件名及大小。",
			note_unsupported_type: "不支持的文件类型 — 仅保留文件名（{name}）。",
			hint_prefer_local: "优先使用本地运行时",
			hint_local_gemma: "本地 Gemma 模型",
			hint_local_qwen: "本地 Qwen 模型",
			hint_auto_route: "自动智能路由",
			hint_same_as_auto: "等同于 uptokey-auto",
			hint_pubmed: "PubMed 医学论文",
			hint_crossref: "Crossref DOI 文献",
			hint_open_library: "Open Library 图书馆",
			hint_local_model: "本地模型",
			ws_title: "研究工作",
			ws_open: "检索并生成报告",
			ws_hide: "隐藏工作面板",
			ws_unavailable: "工作区执行尚未连接。本地工作区可用后，计划、步骤、证据和导出会显示在这里。",
			ws_contract_mismatch: "该工作使用的契约版本与此界面不同，数值可能不完整。",
			ws_goal: "这项工作要做什么？",
			ws_goal_placeholder: "例如：关于维生素D与免疫的近期综述",
			ws_create: "创建工作",
			ws_update: "更新工作",
			ws_save_recipe: "保存例程",
			ws_recipe_saved: "例程已保存",
			ws_recipe_note: "例程保存参数和步骤。它不包含密钥或授权，本身也不授权执行。",
			ws_plan: "计划",
			ws_plan_sources: "来源",
			ws_plan_destination: "数据去向",
			ws_plan_model: "模型",
			ws_plan_limits: "限额",
			ws_approve: "授权并执行",
			ws_approval_note: "授权与该计划绑定。实质性变更需要重新授权。",
			ws_state_draft: "草稿",
			ws_state_awaiting_approval: "等待授权",
			ws_state_ready: "就绪",
			ws_state_running: "执行中",
			ws_state_succeeded: "已完成",
			ws_state_failed: "失败",
			ws_state_cancelled: "已中断",
			ws_state_needs_attention: "需要关注",
			ws_steps: "步骤",
			ws_step_prepared: "已准备",
			ws_step_dispatched: "已发送",
			ws_step_succeeded: "已完成",
			ws_step_failed: "失败",
			ws_step_unknown: "结果未知",
			ws_step_unknown_note: "已发送但结果未确认，不会自动重试。",
			ws_step_account_note: "未发送：关联账户没有有效的观测余额、足够余额或已知单价。请在“账户”中检查。",
			ws_cancel: "中断",
			api_field_pokemon_name: "宝可梦名称",
			api_field_owner: "所有者",
			api_field_repo: "仓库",
			api_field_state: "状态",
			api_field_page: "页",
			api_field_per_page: "每页",
			api_field_indicator: "指标",
			api_field_format: "格式",
			api_op_get_public_repository_issues: "获取公共仓库的 issue",
			api_op_get_public_repository_pulls: "获取公共仓库的 pull",
			api_op_get_pokemon: "获取宝可梦",
			api_op_get_country_indicator: "获取国家指标",
			api_op_get_apod: "每日天文图片",
			repoUrl: "仓库 URL",
			recipe_param_repoUrl: "仓库 URL",
			ws_cancelled_note: "已中断。显示最后保存的状态。",
			ws_evidence: "已查阅的证据",
			ws_evidence_consulted: "{date} 查阅",
			ws_evidence_not_retrieved: "未取回",
			ws_evidence_empty: "尚未查阅任何来源。",
			ws_result: "结果",
			ws_delete_confirm: "永久删除此项目、报告和历史记录？导出的文件和导入的原始数据将保留。",
			ws_import: "导入所选上下文",
			ws_context: "本次执行的上下文",
			project_choose_folder: "选择文件夹（可选）",
			ws_import_note: "选择要复制到本地的消息或已保存的附件文本。如果缺少文本，请重新附加文件。保留原始内容。再次导入将打开现有副本，不会执行任务。",
			ws_constraints: "约束（每行一项）",
			ws_compare: "与上一份报告比较（− 删除，+ 添加）",
			ws_result_open: "打开",
			ws_persisted_note: "已保存在本地工作区。这不是已导出的文件。",
			ws_export_folder: "保存到项目文件夹",
			ws_export_download: "下载",
			ws_export_done: "已导出为 {name}",
			ws_export_failed: "导出失败。报告仍保存在工作区中。",
			ws_export_overwrite: "覆盖项目文件夹中的 {name} 吗？",
			ws_export_no_folder: "此浏览器中没有已授权的项目文件夹。重新打开后可能需要再次授权。",
			ws_usage_title: "本月用量",
			ws_usage_charged: "Uptokey 收费",
			ws_usage_reference: "用量的参考价值",
			ws_usage_reference_note: "按公开参考费率估算。既不是账单，也不是已确认的节省。",
			ws_usage_coverage: "计量覆盖率",
			ws_usage_coverage_value: "{observed} 次调用中的 {included} 次",
			ws_usage_details: "核对计算",
			ws_usage_basis_provider: "提供方报告",
			ws_usage_basis_estimated: "估算",
			ws_usage_basis_unknown: "依据未知",
			ws_usage_cov_included: "已计入",
			ws_usage_cov_missing_usage: "未报告用量",
			ws_usage_cov_missing_tariff: "无费率",
			ws_usage_cov_not_comparable: "不可比",
			ws_usage_cov_estimated: "估算用量",
			ws_usage_cov_local_cache: "本地复用",
			ws_usage_access_public: "公开访问",
			ws_usage_access_byok: "你自己的密钥",
			ws_usage_access_local: "本地执行",
			ws_usage_access_hosted: "托管访问",
			ws_usage_charge_unconfirmed: "本期并非每次调用都确认了计费，因此总额为未知而不是零。",
			ws_usage_no_aggregable: "没有任何调用同时具备已报告用量和对应费率。",
			ws_usage_cached: "缓存 {cached}",
			ws_usage_rate: "输入 {input}/M · 输出 {output}/M",
			ws_usage_reused: "复用的回答",
			ws_usage_tariff: "费率 {id} · {checkedAt}",
			ws_usage_byok_note: "Uptokey 收费并不等于全部成本：BYOK 可能由提供方直接计费，本地模型则消耗你自己的设备与电力。",
			ws_usage_units: "输入 {input} · 输出 {output}",
			ws_usage_empty: "此期间没有已计量的调用。",
			ws_step_pending: "待处理",
			ws_plan_limits_value: "{steps} 步 · {calls} 次调用 · 输出 {tokens} · {seconds} 秒",
			ws_capability_unavailable: "不可执行",
			ws_evidence_note: "快照记录的是当时读取到的内容，并不代表内容属实。",
			"workflow.sources.crossref.search.title": "搜索 Crossref",
			"workflow.sources.crossref.search.description": "在公开的 Crossref 目录中查找论文和 DOI。",
			"workflow.sources.open-library.search.title": "搜索 Open Library",
			"workflow.sources.open-library.search.description": "在公开的 Open Library 目录中查找图书和作者。",
			"workflow.sources.pubmed.search.title": "搜索 PubMed",
			"workflow.sources.pubmed.search.description": "在 PubMed 中查找生物医学文献。",
			"workflow.sources.openalex.search.title": "搜索 OpenAlex",
			"workflow.sources.openalex.search.description": "在 OpenAlex 公共目录中查找学术作品。",
			"workflow.sources.archive.search.title": "搜索档案",
			"workflow.sources.archive.search.description": "在档案来源中查找历史记录。",
			"workflow.sources.rss.read.title": "读取 RSS 源",
			"workflow.sources.rss.read.description": "从公共 RSS 或 Atom 源获取条目。",
			"workflow.capabilities.project_write.title": "写入项目文件",
			"workflow.capabilities.project_write.description": "在已授权的项目文件夹内创建或编辑文件。",
			chat_edit: "编辑",
			chat_regenerate: "重新生成",
			chat_save_submit: "保存并发送",
			chat_cancel_edit: "取消",
			cap_discovery_title: "功能发现",
			cap_discovery_search_placeholder: "按名称、标签或目标搜索功能...",
			cap_filter_all: "全部",
			cap_filter_available: "可用",
			cap_filter_configurable: "需配置",
			cap_filter_unavailable: "不可用",
			cap_tier_available: "可用",
			cap_tier_configurable: "需配置",
			cap_tier_unavailable: "不可用",
			cap_action_open_form: "打开表单",
			cap_action_prepare: "准备方案",
			cap_action_configure: "配置",
			cap_action_unavailable: "不可用",
			cap_action_details: "详情",
			cap_action_hide_details: "隐藏详情",
			cap_action_clear_search: "清除搜索",
			cap_filter_group_label: "按可用性筛选功能",
			cap_label_destination: "目标",
			cap_label_effect: "效果",
			cap_label_limits: "执行限制",
			cap_label_tags: "标签",
			cap_label_schemas: "输入/输出模式",
			cap_label_retry_class: "重试策略",
			cap_empty_title: "未找到功能",
			cap_empty_desc: "没有与当前搜索或筛选条件匹配的功能。",
			cap_empty_unregistered: "该工作区尚未注册任何功能。",
			cap_reason_executable: "可准备执行方案",
			cap_reason_catalogued: "已编目：需要额外配置",
			cap_reason_missing_scopes: "需要权限：{scopes}",
			cap_reason_scopes_unknown: "权限未确认；需要：{scopes}",
			cap_reason_unavailable: "在此环境中不可执行",
			cap_reason_incompatible_schema: "功能元数据不兼容或不完整",
			cap_reason_unknown: "描述符元数据不完整或未识别",
			cap_unknown_title: "功能：{id}",
			cap_unknown_desc: "描述符元数据不可用。",
			cap_effect_read_external: "外部读取",
			cap_effect_write_external: "外部写入",
			cap_effect_inference: "推理",
			cap_effect_produce_artifact: "生成工件",
			cap_effect_execute_local: "本地运行",
			cap_destination_public: "公共来源：{id}",
			cap_destination_local: "本地：{id}",
			cap_destination_provider: "提供商：{id}",
			cap_destination_unknown: "目标：{id}",
			cap_limits: "{steps} 步 · {calls} 次调用 · {tokens} 个令牌 · {timeout}秒",
			cap_results_count: "找到 {count} 项功能",
			cap_results_sr: "正在显示 {count} 项功能",
			cx_accounts_title: "帐户与权限",
			cx_connections_loading: "正在加载连接…",
			cx_connections_failed: "无法加载连接。请重试。",
			cx_connections_retry: "重试",
			cx_accounts_sub: "一个提供商，多个帐户。密钥保留在此设备上。",
			cx_add_account: "添加帐户",
			cx_provider_id: "提供方标识",
			cx_access_mode: "访问模式",
			cx_get_access: "获取访问权限",
			cx_oauth_client_id: "OAuth client_id",
			cx_configure: "配置",
			cx_label: "名称",
			cx_secret: "密钥",
			cx_secret_hint: "留空即取消。",
			cx_endpoint: "端点",
			cx_models: "模型（以逗号分隔）",
			cx_add: "添加",
			cx_save: "保存",
			cx_test: "测试",
			cx_test_all: "测试全部",
			cx_test_inference: "使用提供商调用进行测试",
			cx_testing: "测试中…",
			cx_consent: "允许有上限的调用",
			cx_cap_usd: "上限（USD）",
			cx_cancel: "取消",
			cx_revoke: "撤销",
			cx_confirm_revoke: "再次点击确认",
			cx_reconnect: "重新连接",
			cx_rename: "重命名",
			cx_disable: "禁用",
			cx_enable: "启用",
			cx_primary: "设为主要",
			cx_install: "下载",
			cx_model: "模型",
			cx_size_unknown: "大小未知",
			cx_no_accounts: "暂无帐户。添加第一个帐户以在此测试。",
			cx_resume: "继续",
			cx_connect_oauth: "使用{provider}连接",
			cx_error: "错误：{type}",
			cx_job_state: "任务：{state}",
			cx_st_healthy: "健康",
			cx_st_degraded: "已降级",
			cx_st_unauthenticated: "无密钥",
			cx_st_disabled: "已禁用",
			cx_st_unconfigured: "未配置",
			cx_st_unknown: "未知",
			cx_st_expired: "已过期",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "未授权",
			cx_rs_rate_limited: "超出速率限制",
			cx_rs_timeout: "超时",
			cx_rs_unreachable: "无法访问",
			cx_rs_skipped: "已跳过",
			cx_rs_failed: "失败",
			cap_scope_required: "需要权限",
			cap_no_action_available: "参考功能：此工作区中没有直接执行表单",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		},
		ar: {
			ws_embeddings_title: "التضمينات",
			ws_embeddings_description: "أنشئ متجهات باستخدام النموذج المتصل.",
			ws_automation_schedule_authorize: "تفويض الجدول",
			ws_automation_schedule_scope: "إذن متكرر محدود بالنطاق والعدد وتاريخ الانتهاء.",
			ws_automation_channel_resend: "إرسال عبر Resend",
			ws_automation_channel_brevo: "إرسال عبر Brevo",
			ws_automation_channel_slack: "إرسال عبر Slack",
			ws_automation_channel_description: "أرسل الرسالة المراجعة بعد التفويض.",
			classification_semantic_title: "تصنيف باستخدام TypeSafe",
			classification_semantic_note: "تحليل النص المحدد فقط؛ النتيجة لا تمنح إذنًا بتنفيذ إجراءات.",
			df_model_plugin: "مرجع إضافة النموذج",
			df_plugin_version: "الإصدار المشار إليه",
			df_plugin_hash: "قيمة SHA-256 المُعلنة",
			df_plugin_note: "مرجع مُعلن في القالب. لا تُثبّت أي حزمة إضافة ولا تُتحقق بصمة أي حزمة.",
			df_temperature: "درجة الحرارة (temperature)",
			df_top_p: "الاحتمال التراكمي (top-p)",
			df_title: "استيراد قالب Dify",
			df_profile: "النطاق المدعوم: بداية → LLM → نهاية مع إدخال نصي واحد. تظل الأدوات والشيفرة وRAG ومتغيرات البيئة وإضافات الأدوات خارج هذا النطاق. يمكن قراءة مراجع إضافات النماذج دون تثبيتها.",
			df_file: "ملف YAML محلي",
			df_file_help: "حتى {bytes} بايت. يُقرأ محليًا ولا يُحفظ ملف YAML.",
			df_source_model: "النموذج في القالب",
			df_target_model: "النموذج المُعدّ لهذه الخطة",
			df_mapping: "يُعرض النموذج الأصلي للمرجعية. تستخدم الرسائل بعد تعبئتها نموذج البوابة المُعدّ فقط، بعد الموافقة.",
			df_template: "القالب",
			df_max_tokens: "الحد الأقصى لرموز الإخراج",
			df_prepare: "إعداد الخطة",
			df_prepare_note: "تُستخدم رسائل القالب بعد تعبئتها فقط. يُستثنى سجل المحادثة السابق والمرفقات ومصادر البحث والمسودة الحالية. يتطلب التنفيذ موافقة منفصلة.",
			df_file_error: "اختر ملف .yaml أو .yml غير فارغ بحجم لا يتجاوز {bytes} بايت. لا تُقبل ملفات البيئة.",
			df_invalid: "رُفض القالب. استخدم مسار بداية → LLM → نهاية دون ميزات أو إعدادات غير مدعومة.",
			df_limit: "يتجاوز الملف أو بنية YAML الحدود المدعومة.",
			df_input_error: "أدخل النص المطلوب بحد أقصى {max} حرفًا وحدّ إخراج من 1 إلى 4096.",
			df_payload_error: "يتجاوز القالب بعد تعبئته حد المحادثة البالغ 12,000 بايت. اختصر النص أو الإدخال.",
			df_read_error: "تعذرت قراءة الملف المحدد.",
			mu_title: "النماذج والحصص",
			mu_refresh: "تحديث",
			mu_no_models: "لا توجد بيانات لنماذج مُعدّة.",
			mu_provider_scope: "حصة محلية مشتركة بين النماذج المُعدّة لدى هذا المزوّد.",
			mu_quota_unknown: "إحصاءات الحصة غير متاحة.",
			mu_table_note: "الحجوزات / الحدود المحلية المُعدّة",
			mu_window: "الفترة",
			mu_reserved_calls: "الاستدعاءات المحجوزة",
			mu_reserved_tokens: "الرموز المحجوزة",
			mu_minute: "الدقيقة الحالية",
			mu_day: "اليوم الحالي",
			mu_reservation_note: "تتضمن حجوزات الرموز المدخلات المقدّرة والحد الأقصى للمخرجات المسموح بها. وهي لا تمثل استهلاكًا مقاسًا.",
			mu_presented_run: "التنفيذ المعروض",
			mu_usage_unknown: "الاستهلاك المقاس غير متاح.",
			mu_input_tokens: "رموز الإدخال المُبلّغ عنها",
			mu_output_tokens: "رموز الإخراج المُبلّغ عنها",
			mu_receipt_coverage: "المحاولات ذات الاستهلاك المُبلّغ عنه بالكامل / محاولات هذا التنفيذ",
			mu_subset_note: "تتضمن الأرقام القياسات المُبلّغ عنها فقط. تبقى القياسات المفقودة مجهولة؛ وهذه الأرقام لا تمثل إجمالي الاستهلاك.",
			mu_router_usage: "استدعاءات الوكيل المباشرة",
			mu_router_scope: "استجابات Router المباشرة الناجحة منذ بدء هذه العملية. يستثني هذا العداد استدعاءات بوابة مساحة العمل ولا يُحفظ بشكل دائم.",
			mu_with_usage: "استجابات ذات استهلاك مُبلّغ عنه",
			mu_without_usage: "استجابات دون استهلاك مُبلّغ عنه",
			mu_in_flight: "استجابات قيد التنفيذ",
			mu_interrupted: "استجابات متوقفة",
			bm_title: "Model comparison",
			bm_back: "Back",
			bm_start_explicit: "Run active probe",
			bm_no_autorun_note: "Opening this panel does not start a benchmark. Active probes require an explicit start.",
			bm_filter: "Filter models",
			bm_filter_placeholder: "Filter by model or provider",
			bm_empty: "No ranking loaded yet. Load or run a probe to compare models.",
			bm_metric: "Metric",
			bm_method: "Method",
			bm_cohort: "Cohort",
			bm_n: "n",
			bm_source_date: "Source date",
			bm_table_caption: "Comparison table",
			bm_model: "Model",
			bm_score: "Score",
			bm_source: "Source",
			bm_tools: "Tools",
			bm_tools_yes: "Yes",
			bm_tools_no: "No",
			bm_exclusions: "Exclusions",
			bm_observations: "Observations",
			bm_stale: "Stale",
			ws_gateway_preview_truncated: "تم اقتطاع المعاينة. تتوفر الإجابة الكاملة في النتيجة النهائية بعد نجاح التنفيذ.",
			ws_gateway_reconnect: "أعد الاتصال للتحقق من حالة هذا العمل.",
			ws_gateway_payload: "الرسائل التي ستُرسل",
			ws_gateway_text_only: "نص فقط: أزل المرفقات ولا تختر مصدراً للبحث.",
			ws_gateway_size: "يجب ألا تتجاوز المحادثة كاملة 12000 بايت. ابدأ محادثة جديدة أو اختصر النص.",
			ws_gateway_title: "محادثة",
			ws_gateway_description: "إرسال الرسائل المعروضة مرة واحدة بعد الموافقة.",
			ws_browser_title: "فحص صفحة محلية",
			ws_speech_playback_error: "تعذر تشغيل هذا الصوت. لن تتكرر عملية التوليد تلقائيًا.",
			ws_image_prepare: "تحضير الصور",
			ws_video_title: "فيديو",
			ws_video_limits_value: "{calls} استدعاءات · {seconds} ثانية إجمالاً",
			ws_video_description: "راجع قبل الإرسال. تعتمد الخيارات المتاحة على النموذج الذي تم إعداده.",
			ws_video_duration: "المدة (ثوانٍ)",
			ws_video_ratio: "نسبة العرض إلى الارتفاع",
			ws_video_resolution: "الدقة",
			ws_video_audio: "إنشاء صوت",
			ws_video_seed: "البذرة (اختياري)",
			ws_video_prepare: "مراجعة طلب الفيديو",
			ws_video_invalid: "تحقق من إعدادات الفيديو أو أعد الاتصال.",
			ws_video_download: "تنزيل MP4",
			ws_video_load: "تحميل الفيديو",
			ws_video_stop_notice: "إيقاف المتابعة لا يلغي الإنشاء لدى المزوّد.",
			ws_video_resume: "استئناف المتابعة",
			ws_video_status_pending: "في قائمة انتظار المزوّد",
			ws_video_status_in_progress: "جارٍ الإنشاء لدى المزوّد",
			ws_video_status_completed: "اكتمل الإنشاء لدى المزوّد",
			ws_video_status_failed: "فشل الإنشاء لدى المزوّد",
			ws_video_status_cancelled: "ألغاه المزوّد",
			ws_video_status_expired: "انتهت صلاحيته لدى المزوّد",
			ws_video_poll_title: "متابعة الفيديو",
			ws_video_poll_description: "الاستعلام عن المهمة المعروفة دون إنشاء فيديو آخر.",
			ws_video_content_title: "جلب الفيديو",
			ws_video_content_description: "تنزيل النتيجة المكتملة إلى مساحة العمل.",
			ws_image_title: "الصور",
			ws_image_description: "حضّر خطة؛ لا تُنشأ الصور إلا بعد الموافقة. يختلف الدعم حسب المزوّد.",
			ws_image_prompt: "الوصف",
			ws_image_count: "عدد الصور",
			ws_image_size: "الحجم (auto أو العرضxالارتفاع)",
			ws_image_quality: "الجودة (اختياري)",
			ws_image_style: "النمط (اختياري)",
			ws_image_load: "تحميل الصورة",
			ws_image_invalid: "تعذر تحضير الصورة أو تحميلها. تحقق من الطلب والاتصال.",
			ws_image_download: "تنزيل الصورة",
			ws_speech_title: "توليد صوت",
			ws_speech_description: "بعد الموافقة، يُحوَّل النص المدخل أدناه فقط إلى صوت باستخدام النموذج المعروض.",
			ws_speech_input: "النص المراد نطقه",
			ws_speech_prepare: "تحضير خطة الصوت",
			ws_speech_invalid: "أدخل نصًا ضمن الحد المحلي البالغ 12,000 بايت بترميز UTF-8.",
			ws_speech_result: "الصوت الناتج",
			ws_speech_result_note: "صوت مولّد بالذكاء الاصطناعي. لا يبدأ التشغيل إلا باختيارك.",
			ws_speech_load: "تحميل الصوت",
			ws_speech_loading: "جارٍ تحميل الصوت…",
			ws_speech_audio_error: "تعذر تحميل الصوت والتحقق منه. حاول تحميله مرة أخرى.",
			ws_speech_limits_value: "{calls} عمليات توليد · {seconds} ثوانٍ",
			ws_transcription_title: "نسخ الصوت",
			ws_transcription_description: "بعد الموافقة، انسخ الصوت المحدد إلى نص قابل للمراجعة باستخدام النموذج المعروض.",
			ws_transcription_file: "ملف صوتي (MP3, WAV, OGG, WEBM, MP4)",
			ws_transcription_language: "اللغة (اختياري، ISO 639-1)",
			ws_transcription_prepare: "تحضير خطة النسخ",
			ws_transcription_invalid: "اختر ملف MP3 واستخدم رمز لغة من حرفين، أو اتركه فارغًا.",
			ws_transcription_result: "النص المنسوخ",
			ws_browser_fill_title: "تعبئة حقول الصفحة المحلية",
			ws_browser_fill_description: "بعد الموافقة، تُعبّأ الحقول المعروضة وتُلتقط الصفحة. لا يُرسل النموذج ولا يُؤكد حفظ البيانات على الخادم.",
			ws_browser_fill_field: "الحقل {number}",
			ws_browser_fill_label: "التسمية الدقيقة للحقل",
			ws_browser_fill_value: "القيمة",
			ws_browser_fill_empty: "القيمة الفارغة تمسح الحقل.",
			ws_browser_fill_add: "إضافة حقل",
			ws_browser_fill_prepare: "تحضير للمراجعة",
			ws_browser_fill_invalid: "استخدم عنوان URL من {origin} ومن 1 إلى 8 تسميات مختلفة (حتى 200 حرف). تقبل كل قيمة 2,000 حرف؛ اختصر القيم إذا كان الطلب الكامل كبيرًا جدًا.",
			ws_browser_fill_local: "فقط {origin}. البرامج النصية للصفحة معطّلة.",
			ws_browser_fill_limits_value: "{steps} خطوات · {calls} إجراءات · {seconds} ثوانٍ",
			ws_browser_description: "فحص صفحة محلية بعد الموافقة، دون نقرات أو تفاعل مع النماذج.",
			ws_tools_result_prepare: "تحضير رد باستخدام هذه النتيجة",
			project_changeset_title: "تغييرات الملفات المقترحة",
			project_changeset_note: "اقترح النموذج هذه التغييرات. لا يُكتب أي شيء قبل موافقتك على الخطة؛ يتحقق الخادم من التجزئات قبل الكتابة.",
			project_apply: "مراجعة وتطبيق",
			project_apply_busy: "جارٍ التحضير…",
			project_apply_started: "تمت الموافقة على الخطة. بدأ تنفيذ الكتابة؛ أعد فتح مساحة العمل لعرض النتيجة.",
			project_apply_bind_first: "اربط المجلد عبر الوكيل المحلي قبل تطبيق التغييرات.",
			project_apply_unavailable: "تطبيق التغييرات غير متاح في هذه الجلسة.",
			ws_tools_result_consent: "ستُرسل هذه النتيجة إلى النموذج فقط بعد موافقتك على الخطة الجديدة.",
			ws_tools_enable: "اقتراح إجراءات محلية في المحادثة",
			ws_tools_description: "تتيح الأدوات المحددة للنموذج اقتراح إجراءات. كل إجراء يحتاج إلى خطة مستقلة وموافقتك.",
			ws_tools_proposal: "اقتراح إجراء",
			ws_tools_not_executed: "هذه الرسالة اقتراح. تحضير إجراء لا ينفذه؛ وافق على الخطة الجديدة لتنفيذه.",
			ws_tools_prepare: "تحضير هذا الإجراء",
			ws_filesystem_title: "بيانات الملفات المحلية الوصفية",
			ws_filesystem_tool: "الأداة",
			ws_filesystem_path: "المسار النسبي",
			ws_filesystem_list: "عرض محتويات المجلد",
			ws_filesystem_info: "معلومات الملف",
			ws_filesystem_description: "الأسماء والبيانات الوصفية في المجلد المحدد فقط. لا قراءة لمحتوى الملفات ولا تعديلها.",
			ws_filesystem_unavailable: "أدوات الملفات المحلية غير متاحة.",
			ws_filesystem_invalid: "تحقق من المسار أو أعد الاتصال لتحديث الأدوات ثم حضّر خطة جديدة.",
			ws_browser_open: "فحص صفحة محلية",
			ws_composition_open: "الخطوة التالية المشروطة",
			ws_composition_description: "تحقق من نص حرفي مع مراعاة حالة الأحرف في النتيجة المحلية المحددة. التطابق يقترح فحصًا آخر فقط، ويتطلب موافقة جديدة.",
			ws_composition_contains: "إذا احتوت النتيجة على",
			ws_composition_next: "اقتراح فحص هذا الرابط",
			ws_composition_check: "تحقق من الشرط",
			ws_composition_no_match: "لم يُعثر على النص. لم تُنشأ خطة تالية.",
			ws_composition_ready: "تحقق الشرط. راجع الخطة التالية قبل الموافقة.",
			ws_composition_review: "يحتاج هذا التسلسل إلى مراجعة. لم تُنفذ خطوة تالية.",
			ws_composition_review_plan: "مراجعة الخطة التالية",
			ws_browser_url: "عنوان URL للصفحة المحلية",
			ws_browser_prepare: "تحضير الفحص",
			ws_browser_invalid: "أدخل عنوان URL كاملاً من المصدر {origin}. يبدأ الفحص بعد الموافقة فقط.",
			ws_browser_limits_value: "{steps} خطوات · {calls} عمليات فحص · {seconds} ثوانٍ",
			ws_download_requested: "تم طلب تنزيل {name}. تحقق من تنزيلات المتصفح.",
			title: "ذكاؤك الاصطناعي. مصادر حقيقية.",
			connect: "اتصال",
			disconnect: "قطع الاتصال",
			connected: "متصل",
			offline: "غير متصل",
			connecting: "جارٍ الاتصال…",
			send: "إرسال",
			stop: "إيقاف",
			placeholder: "اسأل أي شيء… استخدم @ لاختيار النماذج أو مصادر البحث.",
			hint: "Ctrl+Enter للإرسال · Esc للإيقاف · ميكروفون للإملاء · @ للإشارات · المرفقات",
			model: "النموذج",
			sources: "بحث",
			newChat: "محادثة جديدة",
			empty_title: "ذكاؤك الاصطناعي. مصادر حقيقية.",
			empty_body: "اتصل بالوكيل المحلي (127.0.0.1:21435)، اختر نموذجاً محلياً أو نموذج بمفتاحك الخاص، اختيارياً @pubmed / @crossref / @open-library، ثم ابدأ السؤال. تبقى مفاتيحك دائماً على هذا الجهاز.",
			you: "أنت",
			ai: "الذكاء الاصطناعي",
			searching: "جارٍ البحث عن المراجع…",
			answering: "جارٍ التفكير…",
			queryLabel: "كلمات البحث",
			queryHint: "حرفان على الأقل للبحث في المصادر",
			local: "محلي",
			cloud: "سحابي BYOK",
			research: "بحث",
			connections: "الاتصالات",
			history: "السجل",
			theme: "المظهر",
			theme_dark: "داكن",
			theme_light: "فاتح",
			theme_auto: "تلقائي",
			keys_local: "تبقى المفاتيح على الجهاز",
			attach: "إرفاق ملفات",
			remove: "إزالة",
			stop_kept: "تم الإيقاف — تم الاحتفاظ بالإجابة الجزئية",
			unknown: "غير معروف",
			cost_unknown: "التكلفة: غير معروفة",
			fallback_on: "تم تفعيل التبديل الاحتياطي",
			disabled_zai: "للبحث فقط / محظور في الوكيل",
			disabled_openalex: "غير معتمد في الوكيل",
			openalex: "OpenAlex",
			zai: "Z.AI",
			ollama: "Ollama",
			vllm: "vLLM",
			runtime_offline: "غير متصل",
			runtime_ok: "متاح",
			no_local_models: "لم يتم العثور على نماذج محلية بعد.",
			no_history: "لا توجد محادثات محفوظة بعد. ابدأ محادثة جديدة — ستبقى في هذا المتصفح.",
			attach_busy: "جارٍ قراءة الملف…",
			err_provision: "فشل التزويد — هل يعمل الوكيل على 127.0.0.1:21435؟",
			err_request: "فشل الطلب",
			err_source: "فشل البحث في المصدر",
			err_source_rate: "تم تجاوز معدل استعلام المصدر — أعد المحاولة بعد قليل",
			err_capacity: "سعة النظام المحلي مشغولة — أعد المحاولة",
			err_invalid: "طلب غير صالح",
			menu: "فتح القائمة الجانبية",
			close_menu: "إغلاق القائمة الجانبية",
			lang: "اللغة",
			credits: "الرصيد",
			size_est: "الحجم التقريبي",
			aliases: "أسماء مستعارة محلية",
			discovered: "النماذج المثبتة",
			none_source: "الذكاء الاصطناعي فقط",
			papers: "أوراق بحثية",
			books: "كتب",
			delete_chat: "حذف",
			composer_disabled: "اتصل بالوكيل المحلي لبدء المحادثة",
			connect_first: "اتصل بالوكيل المحلي قبل الإرسال",
			more_options: "المزيد من الخيارات",
			hide_options: "إخفاء الخيارات",
			new_project: "مشروع جديد",
			projects: "المشاريع",
			project_name: "اسم المشروع",
			local_storage: "مخزن محلياً",
			streaming: "جارٍ البث…",
			mic: "إملاء صوتي",
			mic_stop: "إيقاف الإملاء",
			mic_listening: "جارٍ الاستماع…",
			mic_unsupported: "الإملاء الصوتي غير مدعوم في هذا المتصفح",
			mic_denied: "تم رفض إذن الوصول إلى الميكروفون",
			mic_error: "فشل الإملاء الصوتي",
			sidebar: "القائمة الجانبية",
			note_text_read_failed: "تعذر قراءة ملف النص — الاسم فقط.",
			note_pdf_empty: "ملف PDF لا يحتوي على نص قابل للاستخراج (الاسم فقط).",
			note_pdf_unavailable: "استخراج نص PDF غير متاح — مرفق بالاسم فقط.",
			note_doc_binary: "صيغة غير مدعومة — الاسم فقط (.doc ثنائي).",
			note_doc_unsupported: "صيغة غير مدعومة — الاسم فقط (docx).",
			note_doc_compressed: "صيغة غير مدعومة — الاسم فقط (docx مضغوط).",
			note_doc_besteffort: "نص تقريبي لملف docx (قد يكون غير مكتمل).",
			note_unsupported_parse: "تعذر التحليل — الاسم فقط.",
			note_image_attached: "تم إرفاق صورة ({name}، {size} بايت). تُرسل للنموذج فقط إن كان يدعم الرؤية.",
			note_image_preview_failed: "تم إرفاق صورة ({name}) — فشلت المعاينة.",
			note_audio_attached: "تم إرفاق ملف صوتي ({name}، {size} بايت) — لا يتم تحويل الصوت إلى نص، يُشارك الاسم والحجم فقط.",
			note_unsupported_type: "نوع الملف غير مدعوم — الاسم فقط ({name}).",
			hint_prefer_local: "تفضيل التشغيل المحلي",
			hint_local_gemma: "نموذج Gemma محلي",
			hint_local_qwen: "نموذج Qwen محلي",
			hint_auto_route: "توجيه تلقائي",
			hint_same_as_auto: "مطابق لـ uptokey-auto",
			hint_pubmed: "أوراق PubMed",
			hint_crossref: "معرفات Crossref DOI",
			hint_open_library: "كتب Open Library",
			hint_local_model: "نموذج محلي",
			ws_title: "عمل بحثي",
			ws_open: "ابحث وأنشئ تقريرًا",
			ws_hide: "إخفاء لوحة العمل",
			ws_unavailable: "لم يتم توصيل تنفيذ مساحة العمل بعد. ستظهر هنا الخطة والخطوات والأدلة والتصدير عندما تتوفر مساحة العمل المحلية.",
			ws_contract_mismatch: "يستخدم هذا العمل إصدار عقد يختلف عن هذه الواجهة. قد تكون القيم غير مكتملة.",
			ws_goal: "ما الذي يجب أن يفعله هذا العمل؟",
			ws_goal_placeholder: "مثال: مراجعات حديثة عن فيتامين د والمناعة",
			ws_create: "إنشاء العمل",
			ws_update: "تحديث العمل",
			ws_save_recipe: "حفظ الروتين",
			ws_recipe_saved: "تم حفظ الروتين",
			ws_recipe_note: "يحفظ الروتين المعاملات والخطوات. لا يحمل مفاتيح ولا أذونات ولا يمنح تصريحًا بالتنفيذ من تلقاء نفسه.",
			ws_plan: "الخطة",
			ws_plan_sources: "المصادر",
			ws_plan_destination: "وجهة البيانات",
			ws_plan_model: "النموذج",
			ws_plan_limits: "الحدود",
			ws_approve: "التصريح والتشغيل",
			ws_approval_note: "التصريح مرتبط بهذه الخطة. أي تغيير جوهري يتطلب تصريحًا جديدًا.",
			ws_state_draft: "مسودة",
			ws_state_awaiting_approval: "بانتظار التصريح",
			ws_state_ready: "جاهز",
			ws_state_running: "قيد التشغيل",
			ws_state_succeeded: "مكتمل",
			ws_state_failed: "فشل",
			ws_state_cancelled: "متوقف",
			ws_state_needs_attention: "يحتاج انتباهًا",
			ws_steps: "الخطوات",
			ws_step_prepared: "مُعدّة",
			ws_step_dispatched: "أُرسلت",
			ws_step_succeeded: "تمت",
			ws_step_failed: "فشلت",
			ws_step_unknown: "نتيجة غير معروفة",
			ws_step_unknown_note: "أُرسلت دون نتيجة مؤكدة. لا تُعاد تلقائيًا.",
			ws_step_account_note: "لم يُرسل: لا يوجد للحساب المرتبط رصيد مرصود ساري أو رصيد كافٍ أو سعر وحدة معروف. راجعه في الحسابات.",
			ws_cancel: "إيقاف",
			api_field_pokemon_name: "اسم البوكيمون",
			api_field_owner: "المالك",
			api_field_repo: "المستودع",
			api_field_state: "الحالة",
			api_field_page: "الصفحة",
			api_field_per_page: "عدد العناصر في كل صفحة",
			api_field_indicator: "المؤشر",
			api_field_format: "الصيغة",
			api_op_get_public_repository_issues: "جلب مشكلات المستودع العام",
			api_op_get_public_repository_pulls: "جلب عمليات السحب من المستودع العام",
			api_op_get_pokemon: "جلب بوكيمون",
			api_op_get_country_indicator: "جلب مؤشر البلد",
			api_op_get_apod: "صورة اليوم الفلكية",
			repoUrl: "عنوان المستودع",
			recipe_param_repoUrl: "عنوان المستودع",
			ws_cancelled_note: "تم الإيقاف. يُعرض آخر وضع محفوظ.",
			ws_evidence: "الأدلة التي جرى الاطلاع عليها",
			ws_evidence_consulted: "جرى الاطلاع في {date}",
			ws_evidence_not_retrieved: "لم تُسترجع",
			ws_evidence_empty: "لم يتم الاطلاع على أي مصدر بعد.",
			ws_result: "النتيجة",
			ws_delete_confirm: "هل تريد حذف المشروع وتقاريره وسجله نهائيًا؟ تبقى الملفات المصدرة والبيانات الأصلية المستوردة.",
			ws_import: "استيراد السياق المحدد",
			ws_context: "سياق هذا التنفيذ",
			project_choose_folder: "اختيار مجلد (اختياري)",
			ws_import_note: "حدد الرسائل أو نصوص المرفقات المحفوظة لنسخها محليًا. إذا لم يُحفظ النص، فأرفق الملف مجددًا. يُحفظ الأصل. إعادة الاستيراد تفتح النسخة الموجودة. لا يتم تنفيذ أي مهمة.",
			ws_constraints: "القيود (واحد في كل سطر)",
			ws_compare: "مقارنة بالتقرير السابق (− محذوف، + مضاف)",
			ws_result_open: "فتح",
			ws_persisted_note: "محفوظ في مساحة العمل المحلية. هذا ليس ملفًا مُصدَّرًا.",
			ws_export_folder: "الحفظ في مجلد المشروع",
			ws_export_download: "تنزيل",
			ws_export_done: "تم التصدير باسم {name}",
			ws_export_failed: "فشل التصدير. التقرير ما زال محفوظًا في مساحة العمل.",
			ws_export_overwrite: "هل تريد استبدال {name} في مجلد المشروع؟",
			ws_export_no_folder: "لا يوجد مجلد مشروع مُصرّح به في هذا المتصفح. قد تحتاج إلى منح الإذن مجددًا بعد إعادة الفتح.",
			ws_usage_title: "استخدامك هذا الشهر",
			ws_usage_charged: "ما تحاسب عليه Uptokey",
			ws_usage_reference: "القيمة المرجعية للاستخدام",
			ws_usage_reference_note: "تقدير وفق التعرفة المرجعية المعلنة. ليس فاتورة ولا توفيرًا مؤكدًا.",
			ws_usage_coverage: "تغطية القياس",
			ws_usage_coverage_value: "{included} من {observed} طلبًا",
			ws_usage_details: "مراجعة الحساب",
			ws_usage_basis_provider: "مُبلَّغ من المزوّد",
			ws_usage_basis_estimated: "مُقدَّر",
			ws_usage_basis_unknown: "أساس غير معروف",
			ws_usage_cov_included: "مُحتسبة",
			ws_usage_cov_missing_usage: "بلا استخدام مُبلَّغ",
			ws_usage_cov_missing_tariff: "بلا تعرفة",
			ws_usage_cov_not_comparable: "غير قابلة للمقارنة",
			ws_usage_cov_estimated: "استخدام مُقدَّر",
			ws_usage_cov_local_cache: "مُعاد استخدامها محليًا",
			ws_usage_access_public: "وصول عام",
			ws_usage_access_byok: "مفتاحك الخاص",
			ws_usage_access_local: "تنفيذ محلي",
			ws_usage_access_hosted: "وصول مُستضاف",
			ws_usage_charge_unconfirmed: "لم تؤكّد كل الطلبات في هذه الفترة وجود محاسبة، لذلك يبقى المجموع غير معروف بدل أن يكون صفرًا.",
			ws_usage_no_aggregable: "لا يوجد طلب جمع بين استخدام مُبلَّغ وتعرفة مطابقة.",
			ws_usage_cached: "{cached} من الذاكرة المؤقتة",
			ws_usage_rate: "{input}/م إدخال · {output}/م إخراج",
			ws_usage_reused: "إجابة مُعاد استخدامها",
			ws_usage_tariff: "التعرفة {id} · {checkedAt}",
			ws_usage_byok_note: "ما تحاسب عليه Uptokey ليس التكلفة الكاملة: قد يحاسبك المزوّد مباشرة في وضع BYOK، والنموذج المحلي يستهلك جهازك وطاقتك.",
			ws_usage_units: "{input} إدخال · {output} إخراج",
			ws_usage_empty: "لا توجد طلبات مقيسة في هذه الفترة.",
			ws_step_pending: "قيد الانتظار",
			ws_plan_limits_value: "{steps} خطوات · {calls} طلبات · {tokens} إخراج · {seconds}ث",
			ws_capability_unavailable: "غير قابلة للتنفيذ",
			ws_evidence_note: "تسجّل اللقطة ما جرت قراءته في تلك اللحظة، وهذا لا يجعل المحتوى صحيحًا.",
			"workflow.sources.crossref.search.title": "البحث في Crossref",
			"workflow.sources.crossref.search.description": "يبحث عن المقالات ومعرّفات DOI في فهرس Crossref العام.",
			"workflow.sources.open-library.search.title": "البحث في Open Library",
			"workflow.sources.open-library.search.description": "يبحث عن الكتب والمؤلفين في فهرس Open Library العام.",
			"workflow.sources.pubmed.search.title": "البحث في PubMed",
			"workflow.sources.pubmed.search.description": "يبحث عن الأدبيات الطبية الحيوية في PubMed.",
			"workflow.sources.openalex.search.title": "البحث في OpenAlex",
			"workflow.sources.openalex.search.description": "يبحث عن الأعمال الأكاديمية في كتالوج OpenAlex العام.",
			"workflow.sources.archive.search.title": "البحث في الأرشيف",
			"workflow.sources.archive.search.description": "يبحث عن السجلات التاريخية في مصدر الأرشيف.",
			"workflow.sources.rss.read.title": "قراءة خلاصة RSS",
			"workflow.sources.rss.read.description": "يجلب الإدخالات من خلاصة RSS أو Atom عامة.",
			"workflow.capabilities.project_write.title": "كتابة ملفات المشروع",
			"workflow.capabilities.project_write.description": "ينشئ أو يحرر ملفات داخل مجلد المشروع المصرح به.",
			chat_edit: "تعديل",
			chat_regenerate: "إعادة التوليد",
			chat_save_submit: "حفظ وإرسال",
			chat_cancel_edit: "إلغاء",
			cap_discovery_title: "استكشاف الإمكانات",
			cap_discovery_search_placeholder: "البحث عن الإمكانات حسب الاسم أو العلامة أو الوجهة...",
			cap_filter_all: "الكل",
			cap_filter_available: "متاح",
			cap_filter_configurable: "قابل للإعداد",
			cap_filter_unavailable: "غير متاح",
			cap_tier_available: "متاح",
			cap_tier_configurable: "قابل للإعداد",
			cap_tier_unavailable: "غير متاح",
			cap_action_open_form: "فتح النموذج",
			cap_action_prepare: "إعداد الخطة",
			cap_action_configure: "إعداد",
			cap_action_unavailable: "غير متاح",
			cap_action_details: "التفاصيل",
			cap_action_hide_details: "إخفاء التفاصيل",
			cap_action_clear_search: "مسح البحث",
			cap_filter_group_label: "تصفية الإمكانات حسب التوفر",
			cap_label_destination: "الوجهة",
			cap_label_effect: "التأثير",
			cap_label_limits: "حدود التنفيذ",
			cap_label_tags: "العلامات",
			cap_label_schemas: "مخططات الإدخال والإخراج",
			cap_label_retry_class: "سياسة إعادة المحاولة",
			cap_empty_title: "لم يتم العثور على أي إمكانات",
			cap_empty_desc: "لا توجد إمكانات تطابق البحث أو عوامل التصفية الحالية.",
			cap_empty_unregistered: "لم يتم تسجيل أي إمكانات في مساحة العمل هذه حتى الآن.",
			cap_reason_executable: "جاهز لإعداد خطة التنفيذ",
			cap_reason_catalogued: "مفهرس: يتطلب إعداداً إضافياً",
			cap_reason_missing_scopes: "يتطلب صلاحيات: {scopes}",
			cap_reason_scopes_unknown: "الصلاحيات غير مؤكدة؛ يتطلب: {scopes}",
			cap_reason_unavailable: "غير قابل للتنفيذ في هذه البيئة",
			cap_reason_incompatible_schema: "بيانات وصفية للإمكانية غير متوافقة أو غير مكتملة",
			cap_reason_unknown: "بيانات الواصف غير مكتملة أو غير معروفة",
			cap_unknown_title: "الإمكانية: {id}",
			cap_unknown_desc: "بيانات الواصف الوصفية غير متوفرة.",
			cap_effect_read_external: "قراءة خارجية",
			cap_effect_write_external: "كتابة خارجية",
			cap_effect_inference: "استنتاج",
			cap_effect_produce_artifact: "إنتاج عنصر",
			cap_effect_execute_local: "تشغيل محلي",
			cap_destination_public: "مصدر عام: {id}",
			cap_destination_local: "محلي: {id}",
			cap_destination_provider: "مزود: {id}",
			cap_destination_unknown: "الوجهة: {id}",
			cap_limits: "{steps} خطوات · {calls} استدعاءات · {tokens} رموز · {timeout} ثانية",
			cap_results_count: "تم العثور على {count} من الإمكانات",
			cap_results_sr: "عرض {count} من الإمكانات",
			cx_accounts_title: "الحسابات والأذونات",
			cx_connections_loading: "جارٍ تحميل الاتصالات…",
			cx_connections_failed: "تعذّر تحميل الاتصالات. يرجى المحاولة مرة أخرى.",
			cx_connections_retry: "إعادة المحاولة",
			cx_accounts_sub: "موفّر واحد، حسابات عدة. تبقى المفاتيح على هذا الجهاز.",
			cx_add_account: "إضافة حساب",
			cx_provider_id: "معرّف المزوّد",
			cx_access_mode: "وضع الوصول",
			cx_get_access: "الحصول على وصول",
			cx_oauth_client_id: "Identificador OAuth (client_id)",
			cx_configure: "تهيئة",
			cx_label: "الاسم",
			cx_secret: "المفتاح",
			cx_secret_hint: "تركه فارغًا يلغي.",
			cx_endpoint: "نقطة النهاية",
			cx_models: "النماذج (مفصولة بفواصل)",
			cx_add: "إضافة",
			cx_save: "حفظ",
			cx_test: "اختبار",
			cx_test_all: "اختبار الكل",
			cx_test_inference: "اختبار بمكالمات الموفّر",
			cx_testing: "جارٍ الاختبار…",
			cx_consent: "السماح بمكالمات مسقوفة",
			cx_cap_usd: "السقف (USD)",
			cx_cancel: "إلغاء",
			cx_revoke: "إبطال",
			cx_confirm_revoke: "انقر مجددًا للتأكيد",
			cx_reconnect: "إعادة الاتصال",
			cx_rename: "إعادة التسمية",
			cx_disable: "تعطيل",
			cx_enable: "تفعيل",
			cx_primary: "تعيين أساسي",
			cx_install: "تنزيل",
			cx_model: "النموذج",
			cx_size_unknown: "الحجم غير معروف",
			cx_no_accounts: "لا توجد حسابات بعد. أضف الأول لاختباره هنا.",
			cx_resume: "استئناف",
			cx_connect_oauth: "الاتصال عبر {provider}",
			cx_error: "خطأ: {type}",
			cx_job_state: "المهمة: {state}",
			cx_st_healthy: "سليم",
			cx_st_degraded: "متدهور",
			cx_st_unauthenticated: "بلا مفتاح",
			cx_st_disabled: "معطّل",
			cx_st_unconfigured: "غير مهيأ",
			cx_st_unknown: "غير معروف",
			cx_st_expired: "منتهٍ",
			cx_rs_ok: "OK",
			cx_rs_unauthorized: "غير مصرّح",
			cx_rs_rate_limited: "تم تجاوز الحد",
			cx_rs_timeout: "انتهت المهلة",
			cx_rs_unreachable: "غير قابل للوصول",
			cx_rs_skipped: "تم التخطي",
			cx_rs_failed: "فشل",
			cap_scope_required: "يتطلب أذونات",
			cap_no_action_available: "إمكانية مرجعية: لا يوجد نموذج تنفيذ مباشر في مساحة العمل هذه",
			"recipe_R-DC-07_name": "GitHub repository briefing",
			"recipe_R-DC-07_desc": "Reads a public GitHub repository and produces a markdown document with its sources."
		}
	};
	for (const _usoLang of USO_LANGS) DICT[_usoLang] = {
		...DICT[_usoLang] ?? {},
		...USO_DICT[_usoLang]
	};
	const LANG_STORAGE_KEY = "quimera.lang.v1";
	/** Supported languages, English always first (comfort fallback + top of any picker). */
	const SUPPORTED_LANGS = [
		"en",
		"pt-BR",
		"es",
		"fr",
		"de",
		"it",
		"ja",
		"ko",
		"zh-CN",
		"ar"
	];
	for (const _lang of SUPPORTED_LANGS) DICT[_lang] = {
		...DICT[_lang] ?? {},
		...flattenMasterDict(_lang)
	};
	/** Explicit user choice — highest priority on next load. */
	function loadStoredLang() {
		try {
			const prefs = readLocalPreferences();
			if (prefs.localeExplicit && prefs.locale && SUPPORTED_LANGS.includes(prefs.locale)) return prefs.locale;
			if (prefs.localeExplicit === false) return null;
			const v = localStorage.getItem(LANG_STORAGE_KEY);
			return SUPPORTED_LANGS.includes(v) ? v : null;
		} catch {
			return null;
		}
	}
	/** Explicit saved choices, then English. OS language never changes the UI. */
	function resolveLang() {
		const prefs = readLocalPreferences();
		if (prefs.localeExplicit && prefs.locale && SUPPORTED_LANGS.includes(prefs.locale)) return prefs.locale;
		const stored = loadStoredLang();
		if (stored) return stored;
		return resolveLocalePreference({ allowTimezoneGuess: false });
	}
	//#endregion
	//#region quimera/uptokey/control-plane/src/personal-subscription-view.ts
	init_plain_data();
	const PLUS_OFFER = Object.freeze({
		plan: "plus",
		amountMinor: 500,
		currency: "USD",
		interval: "month",
		allowanceMicros: 3e6,
		allowanceUnit: "provider_micro_usd"
	});
	function accountRefValid(value) {
		return typeof value === "string" && /^account_[a-f0-9]{64}$/.test(value);
	}
	function exact(value, keys) {
		return isDataRecord(value) && Object.keys(value).sort().join(",") === keys.sort().join(",");
	}
	function iso(value) {
		return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
	}
	function invalid() {
		throw Error("subscription_response_invalid");
	}
	function offer(value) {
		if (value === null) return null;
		if (!exact(value, Object.keys(PLUS_OFFER)) || Object.entries(PLUS_OFFER).some(([key, expected]) => value[key] !== expected)) invalid();
		return { ...PLUS_OFFER };
	}
	function projectSubscriptionOffer(value) {
		if (!exact(value, ["offer"])) invalid();
		return { offer: offer(value.offer) };
	}
	function projectPersonalSubscription(value) {
		if (!exact(value, [
			"accountRef",
			"offer",
			"subscription",
			"allowance"
		]) || !accountRefValid(value.accountRef)) invalid();
		const subscription = value.subscription;
		if (!exact(subscription, [
			"status",
			"cancelAtPeriodEnd",
			"currentPeriodEnd"
		]) || ![
			"none",
			"active",
			"past_due",
			"paused",
			"canceled"
		].includes(String(subscription.status)) || typeof subscription.cancelAtPeriodEnd !== "boolean" || subscription.currentPeriodEnd !== null && !iso(subscription.currentPeriodEnd)) invalid();
		let allowance = null;
		if (value.allowance !== null) {
			const row = value.allowance;
			if (!exact(row, [
				"limitMicros",
				"usedMicros",
				"reservedMicros",
				"periodStart",
				"periodEnd"
			]) || ![
				row.limitMicros,
				row.usedMicros,
				row.reservedMicros
			].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xe8d4a51000) || !iso(row.periodStart) || !iso(row.periodEnd) || row.periodStart >= row.periodEnd) invalid();
			allowance = {
				limitMicros: row.limitMicros,
				usedMicros: row.usedMicros,
				reservedMicros: row.reservedMicros,
				periodStart: row.periodStart,
				periodEnd: row.periodEnd
			};
		}
		return {
			accountRef: value.accountRef,
			offer: offer(value.offer),
			subscription: {
				status: subscription.status,
				cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
				currentPeriodEnd: subscription.currentPeriodEnd
			},
			allowance
		};
	}
	function projectPaddleSubscriptionCheckout(value) {
		if (!exact(value, [
			"accountRef",
			"transactionId",
			"checkoutUrl"
		]) || !accountRefValid(value.accountRef) || typeof value.transactionId !== "string" || !/^txn_[a-z0-9]{26}$/.test(value.transactionId) || typeof value.checkoutUrl !== "string") invalid();
		let url;
		try {
			url = new URL(value.checkoutUrl);
		} catch {
			invalid();
		}
		if (url.origin !== "https://uptokey.com" || url.pathname !== "/checkout" || url.username || url.password || url.hash || [...url.searchParams.keys()].join(",") !== "_ptxn" || url.searchParams.get("_ptxn") !== value.transactionId) invalid();
		return {
			accountRef: value.accountRef,
			transactionId: value.transactionId,
			checkoutUrl: url.href
		};
	}
	function projectPaddleSubscriptionPortal(value) {
		if (!exact(value, ["accountRef", "url"]) || !accountRefValid(value.accountRef) || typeof value.url !== "string" || value.url.length > 4096) invalid();
		let url;
		try {
			url = new URL(value.url);
		} catch {
			invalid();
		}
		if (!["https://customer-portal.paddle.com", "https://sandbox-customer-portal.paddle.com"].includes(url.origin) || url.username || url.password || url.hash || !/^\/cpl_[a-z0-9]{26}$/.test(url.pathname)) invalid();
		return {
			accountRef: value.accountRef,
			url: url.href
		};
	}
	function projectStripeSubscriptionCheckout(value) {
		if (!exact(value, [
			"accountRef",
			"processor",
			"sessionId",
			"checkoutUrl"
		]) || !accountRefValid(value.accountRef) || value.processor !== "stripe" || typeof value.sessionId !== "string" || !/^cs_(?:live|test)_[A-Za-z0-9]{10,240}$/.test(value.sessionId) || typeof value.checkoutUrl !== "string" || value.checkoutUrl.length > 8192) invalid();
		let url;
		try {
			url = new URL(value.checkoutUrl);
		} catch {
			invalid();
		}
		if (url.origin !== "https://checkout.stripe.com" || url.username || url.password || url.pathname !== "/c/pay/" + value.sessionId || url.search || url.href !== value.checkoutUrl) invalid();
		return {
			accountRef: value.accountRef,
			processor: "stripe",
			sessionId: value.sessionId,
			checkoutUrl: url.href
		};
	}
	function projectStripeSubscriptionPortal(value) {
		if (!exact(value, [
			"accountRef",
			"processor",
			"url"
		]) || !accountRefValid(value.accountRef) || value.processor !== "stripe" || typeof value.url !== "string" || value.url.length > 4096) invalid();
		let url;
		try {
			url = new URL(value.url);
		} catch {
			invalid();
		}
		if (url.origin !== "https://billing.stripe.com" || url.username || url.password || !/^\/p\/session\/[A-Za-z0-9_]{10,1024}$/.test(url.pathname) || url.search || url.hash || url.href !== value.url) invalid();
		return {
			accountRef: value.accountRef,
			processor: "stripe",
			url: url.href
		};
	}
	function projectSubscriptionCheckout(value) {
		return isDataRecord(value) && value.processor === "stripe" ? projectStripeSubscriptionCheckout(value) : projectPaddleSubscriptionCheckout(value);
	}
	function projectSubscriptionPortal(value) {
		return isDataRecord(value) && value.processor === "stripe" ? projectStripeSubscriptionPortal(value) : projectPaddleSubscriptionPortal(value);
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/lib/hosted-subscription.ts
	init_limits();
	init_same_origin_client();
	const BASE = "/api/account/subscription";
	var SubscriptionError = class extends Error {
		code;
		constructor(code) {
			super(code);
			this.code = code;
		}
	};
	function checkoutResponseError(status, body) {
		const code = body?.error;
		if (status === 202 && code === "subscription_checkout_pending" || status === 503 && code === "subscription_checkout_disabled" || status === 409 && code === "subscription_checkout_canceled") throw new SubscriptionError(code);
	}
	async function request(path, init, fetcher) {
		const response = await sameOriginFetch(BASE + path, {
			...init,
			credentials: "same-origin",
			cache: "no-store"
		}, fetcher, 3e4);
		if (response.status === 401) {
			response.body?.cancel();
			throw new SubscriptionError("signed_out");
		}
		const body = await readBoundedJson(response, 16384);
		if (!body.ok) throw new SubscriptionError("subscription_response_invalid");
		if (path === "/checkout") checkoutResponseError(response.status, body.value);
		if (!response.ok) throw new SubscriptionError("subscription_request_failed");
		return body.value;
	}
	const readSubscriptionOffer = async (signal, fetcher = fetch) => projectSubscriptionOffer(await request("/offer", { signal }, fetcher));
	const readSubscription = async (signal, fetcher = fetch) => projectPersonalSubscription(await request("", { signal }, fetcher));
	function mutation(accountRef, input, signal) {
		if (!/^account_[a-f0-9]{64}$/.test(accountRef)) throw new SubscriptionError("subscription_response_invalid");
		return {
			method: "POST",
			signal,
			headers: {
				"content-type": "application/json",
				"x-uptokey-chat-scope": accountRef
			},
			body: JSON.stringify(input)
		};
	}
	async function createSubscriptionCheckout(accountRef, requestId, signal, fetcher = fetch) {
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw new SubscriptionError("subscription_response_invalid");
		const result = projectSubscriptionCheckout(await request("/checkout", mutation(accountRef, { requestId }, signal), fetcher));
		if (result.accountRef !== accountRef) throw new SubscriptionError("account_changed");
		return result;
	}
	async function createSubscriptionPortal(accountRef, signal, fetcher = fetch) {
		const result = projectSubscriptionPortal(await request("/portal", mutation(accountRef, {}, signal), fetcher));
		if (result.accountRef !== accountRef) throw new SubscriptionError("account_changed");
		return result;
	}
	const SUBSCRIPTION_INTENT_KEY = "utk-plus-checkout-intent-v1";
	function readSubscriptionIntent(storage, now = Date.now()) {
		try {
			const value = JSON.parse(storage.getItem("utk-plus-checkout-intent-v1") ?? "null");
			if (value?.plan !== "plus" || typeof value.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.requestId) || !Number.isSafeInteger(value.createdAt) || value.createdAt > now || now - value.createdAt >= 9e5 || typeof value.loginStarted !== "boolean" || typeof value.resumed !== "boolean" || Object.keys(value).length !== 5) {
				storage.removeItem(SUBSCRIPTION_INTENT_KEY);
				return null;
			}
			return value;
		} catch {
			return null;
		}
	}
	function saveSubscriptionIntent(storage, intent) {
		storage.setItem(SUBSCRIPTION_INTENT_KEY, JSON.stringify(intent));
	}
	function subscriptionReturnPath(href) {
		const url = new URL(href);
		url.searchParams.set("checkout", "plus");
		url.searchParams.set("subscription", "resume");
		return url.pathname + url.search + url.hash;
	}
	/** Reuses the broker's bounded authenticated envelope; provider credentials never enter this contract. */
	function nativeSubscriptionApi(control) {
		async function call(operation, payload, signal) {
			signal?.throwIfAborted();
			let result;
			try {
				result = await control(operation, payload, signal);
			} catch (error) {
				if (error instanceof Error && ["account_reauthentication_required", "account_link_required"].includes(error.message)) throw new SubscriptionError("signed_out");
				throw error;
			}
			signal?.throwIfAborted();
			if (result.status === 401) throw new SubscriptionError("signed_out");
			if (operation === "subscription.checkout") checkoutResponseError(result.status, result.body);
			if (result.status < 200 || result.status >= 300) throw new SubscriptionError("subscription_request_failed");
			return result.body;
		}
		return {
			offer: async (signal) => projectSubscriptionOffer(await call("subscription.offer", {}, signal)),
			status: async (signal) => projectPersonalSubscription(await call("subscription.status", {}, signal)),
			checkout: async (accountRef, requestId, signal) => {
				mutation(accountRef, {}, signal);
				if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw new SubscriptionError("subscription_response_invalid");
				const result = projectSubscriptionCheckout(await call("subscription.checkout", {
					accountRef,
					requestId
				}, signal));
				if (result.accountRef !== accountRef) throw new SubscriptionError("account_changed");
				return result;
			},
			portal: async (accountRef, signal) => {
				mutation(accountRef, {}, signal);
				const result = projectSubscriptionPortal(await call("subscription.portal", { accountRef }, signal));
				if (result.accountRef !== accountRef) throw new SubscriptionError("account_changed");
				return result;
			}
		};
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/design-bridge/hosted-subscription-client.ts
	init_account_client();
	const native = nativeSubscriptionApi((operation, payload, signal) => requestNativeAccountControl({
		operation,
		payload
	}, void 0, signal));
	const web = {
		offer: readSubscriptionOffer,
		status: readSubscription,
		checkout: createSubscriptionCheckout,
		portal: createSubscriptionPortal
	};
	const api = () => localAccountClient() ? native : web;
	/** Public plan terms are renderable before account/catalog I/O; this does not represent an entitlement. */
	const publicSubscriptionOffer = Object.freeze({ ...PLUS_OFFER });
	function openSubscriptionAccount() {
		requestAccountMenuLogin(!desktopAccount() ? openTab() : null);
	}
	/** The canonical template applies its route locale to the document before account boot. */
	function subscriptionLocale() {
		return subscriptionLocales.find((locale) => locale === document.documentElement.lang) ?? resolveLang();
	}
	let state = {
		loading: false,
		busy: false,
		offer: null,
		account: null,
		error: null,
		pending: false,
		activationPending: false,
		continuation: null
	};
	let installed = false;
	let generation = 0;
	let reading;
	let readAbort;
	let actionAbort;
	let checkoutWindow = null;
	let awaitingReturn = false;
	let retainedIntent = null;
	const listeners = /* @__PURE__ */ new Set();
	const subscriptionSnapshot = () => state;
	function publish(update) {
		state = {
			...state,
			...update
		};
		for (const listener of listeners) listener();
	}
	function subscribeSubscription(listener) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}
	function intent() {
		if (state.pending && retainedIntent) return retainedIntent;
		if (retainedIntent && Date.now() - retainedIntent.createdAt >= 9e5) retainedIntent = null;
		try {
			retainedIntent = readSubscriptionIntent(sessionStorage) ?? retainedIntent;
		} catch {}
		return retainedIntent ??= {
			plan: "plus",
			requestId: crypto.randomUUID(),
			createdAt: Date.now(),
			loginStarted: false,
			resumed: false
		};
	}
	function storeIntent(value) {
		retainedIntent = value;
		try {
			saveSubscriptionIntent(sessionStorage, value);
		} catch {}
	}
	function clearIntent() {
		retainedIntent = null;
		try {
			sessionStorage.removeItem(SUBSCRIPTION_INTENT_KEY);
		} catch {}
	}
	function clearCheckoutQuery() {
		const url = new URL(window.location.href);
		if (!url.searchParams.has("checkout") && !url.searchParams.has("subscription")) return;
		url.searchParams.delete("checkout");
		url.searchParams.delete("subscription");
		history.replaceState(history.state, "", url.pathname + url.search + url.hash);
	}
	function signedOut(error) {
		return error instanceof SubscriptionError && error.code === "signed_out";
	}
	function invalidate() {
		generation++;
		readAbort?.abort();
		actionAbort?.abort();
		reading = void 0;
		checkoutWindow?.close();
		checkoutWindow = null;
		awaitingReturn = false;
		clearIntent();
		publish({
			loading: false,
			busy: false,
			account: null,
			offer: null,
			error: null,
			pending: false,
			activationPending: false,
			continuation: null
		});
	}
	function install() {
		if (installed || typeof window === "undefined") return;
		installed = true;
		subscribeAccountBinding(invalidate);
		window.addEventListener("uptokey:session-ended", invalidate);
		window.addEventListener("uptokey:hosted-conversation-ended", invalidate);
		window.addEventListener("uptokey:account-state", () => {
			invalidate();
			if (listeners.size) refreshSubscription();
		});
		window.addEventListener("focus", () => {
			if (awaitingReturn && document.visibilityState !== "hidden") refreshSubscription();
		});
	}
	function refreshSubscription() {
		install();
		if (localAccountClient() && publicAccountSnapshot()?.authenticated !== true) {
			publish({
				loading: false,
				account: null,
				offer: null,
				error: null
			});
			return Promise.resolve();
		}
		if (reading) return reading;
		const expected = generation, controller = new AbortController();
		readAbort?.abort();
		readAbort = controller;
		publish({
			loading: true,
			error: null
		});
		const work = (async () => {
			try {
				const { offer } = await api().offer(controller.signal);
				let account = null;
				try {
					account = await api().status(controller.signal);
				} catch (error) {
					if (!signedOut(error)) throw error;
				}
				if (controller.signal.aborted || expected !== generation) return;
				const changed = Boolean(state.account && account?.accountRef !== state.account.accountRef);
				if (changed) {
					actionAbort?.abort();
					checkoutWindow?.close();
					checkoutWindow = null;
					clearIntent();
				}
				const active = account?.subscription.status === "active";
				if (active) {
					clearIntent();
					awaitingReturn = false;
					checkoutWindow = null;
				}
				publish({
					offer: account ? account.offer : offer,
					account,
					loading: false,
					pending: active || changed ? false : state.pending,
					activationPending: active || changed ? false : state.activationPending
				});
			} catch {
				if (!controller.signal.aborted && expected === generation) publish({
					loading: false,
					account: null,
					offer: null,
					error: "unavailable"
				});
			} finally {
				if (readAbort === controller) reading = void 0;
			}
		})();
		reading = work;
		return work;
	}
	function openTab() {
		try {
			const tab = window.open("about:blank", "_blank");
			if (tab) tab.opener = null;
			return tab;
		} catch {
			return null;
		}
	}
	async function navigateResult(url, tab, resume) {
		if (desktopAccount()) {
			if (!window.UptokeyDesktop?.openSubscriptionUrl) throw new SubscriptionError("subscription_browser_unavailable");
			const expected = generation;
			await window.UptokeyDesktop.openSubscriptionUrl(url);
			if (expected !== generation) return;
			awaitingReturn = true;
			publish({ continuation: null });
			return;
		}
		awaitingReturn = true;
		if (resume) {
			window.location.assign(url);
			return;
		}
		if (tab && !tab.closed) {
			tab.location.replace(url);
			publish({ continuation: null });
		} else publish({ continuation: url });
	}
	function enterLogin(selected, tab = null) {
		if (selected.loginStarted) throw new SubscriptionError("signed_out");
		const pending = {
			...selected,
			loginStarted: true,
			resumed: false
		};
		storeIntent(pending);
		const returnTo = subscriptionReturnPath(window.location.href);
		const loginUrl = "/auth/login?returnTo=" + encodeURIComponent(returnTo);
		if (tab && !tab.closed) {
			saveSubscriptionIntent(tab.sessionStorage, pending);
			tab.location.replace(loginUrl);
			awaitingReturn = true;
		} else window.location.assign(loginUrl);
	}
	async function startPlusCheckout(resume = false) {
		install();
		if (state.busy) return;
		if (state.activationPending) {
			publish({ error: "activationPending" });
			return;
		}
		const tab = resume || desktopAccount() ? null : openTab();
		checkoutWindow = tab;
		const expected = generation, binding = accountBindingRevision(), controller = new AbortController();
		actionAbort?.abort();
		actionAbort = controller;
		const previous = intent();
		publish({
			busy: true,
			error: null,
			continuation: null
		});
		const selected = resume ? previous : {
			...previous,
			loginStarted: false
		};
		const current = () => !controller.signal.aborted && generation === expected && binding === accountBindingRevision();
		try {
			if (localAccountClient() && publicAccountSnapshot()?.authenticated !== true) {
				tab?.close();
				openSubscriptionAccount();
				return;
			}
			let account;
			try {
				account = state.account ?? await api().status(controller.signal);
			} catch (error) {
				if (current() && signedOut(error)) {
					if (localAccountClient()) {
						tab?.close();
						openSubscriptionAccount();
						return;
					}
					enterLogin(selected, tab);
					return;
				}
				throw error;
			}
			if (!current()) return;
			if (state.account && state.account.accountRef !== account.accountRef) throw new SubscriptionError("account_changed");
			publish({
				account,
				offer: account.offer
			});
			if (account.subscription.status !== "none" && account.subscription.status !== "canceled") {
				clearIntent();
				const result = await api().portal(account.accountRef, controller.signal);
				if (current()) {
					clearCheckoutQuery();
					await navigateResult(result.url, tab, resume);
				}
				return;
			}
			if (!account.offer) throw new SubscriptionError("subscription_not_ready");
			storeIntent({
				...selected,
				resumed: true
			});
			const result = await api().checkout(account.accountRef, selected.requestId, controller.signal);
			if (!current()) return;
			publish({ pending: false });
			let checkoutUrl = result.checkoutUrl;
			if (!("processor" in result)) {
				const localized = new URL(checkoutUrl);
				localized.searchParams.set("lang", subscriptionLocale());
				checkoutUrl = localized.href;
			}
			clearCheckoutQuery();
			await navigateResult(checkoutUrl, tab, resume);
		} catch (error) {
			if (current()) {
				if (signedOut(error) && !selected.loginStarted) {
					publish({ account: null });
					if (localAccountClient()) {
						tab?.close();
						openSubscriptionAccount();
					} else enterLogin(selected, tab);
					return;
				}
				tab?.close();
				if (error instanceof SubscriptionError && error.code === "subscription_checkout_disabled") {
					clearCheckoutQuery();
					publish({
						activationPending: true,
						pending: false,
						error: "activationPending"
					});
					return;
				}
				if (error instanceof SubscriptionError && error.code === "subscription_checkout_pending") {
					clearCheckoutQuery();
					publish({
						pending: true,
						error: "checkoutPending"
					});
					return;
				}
				if (error instanceof SubscriptionError && error.code === "subscription_checkout_canceled" && retainedIntent?.requestId === selected.requestId) {
					clearIntent();
					publish({ pending: false });
				}
				publish({ error: "actionFailed" });
			}
		} finally {
			if (current()) publish({ busy: false });
			if (tab?.closed && checkoutWindow === tab) checkoutWindow = null;
		}
	}
	async function openSubscriptionPortal() {
		install();
		if (state.busy || !state.account) return;
		const accountRef = state.account.accountRef, expected = generation, binding = accountBindingRevision(), controller = new AbortController(), tab = desktopAccount() ? null : openTab();
		checkoutWindow = tab;
		actionAbort?.abort();
		actionAbort = controller;
		publish({
			busy: true,
			error: null,
			continuation: null
		});
		const current = () => !controller.signal.aborted && expected === generation && binding === accountBindingRevision();
		try {
			const result = await api().portal(accountRef, controller.signal);
			if (current()) await navigateResult(result.url, tab, false);
		} catch {
			tab?.close();
			if (current()) publish({ error: "portalFailed" });
		} finally {
			if (current()) publish({ busy: false });
			if (tab?.closed && checkoutWindow === tab) checkoutWindow = null;
		}
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/node_modules/preact/jsx-runtime/dist/jsxRuntime.js
	var require_jsxRuntime = /* @__PURE__ */ __commonJSMin(((exports) => {
		var r = require_preact();
		var e = /["&<]/;
		function t(r) {
			if (0 === r.length || !1 === e.test(r)) return r;
			for (var t = 0, n = 0, o = "", f = ""; n < r.length; n++) {
				switch (r.charCodeAt(n)) {
					case 34:
						f = "&quot;";
						break;
					case 38:
						f = "&amp;";
						break;
					case 60:
						f = "&lt;";
						break;
					default: continue;
				}
				n !== t && (o += r.slice(t, n)), o += f, t = n + 1;
			}
			return n !== t && (o += r.slice(t, n)), o;
		}
		var n = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
		var o = 0;
		var f = Array.isArray;
		function u(e, t, n, f, u, i) {
			t || (t = {});
			var c, a, p = t;
			if ("ref" in p) for (a in p = {}, t) "ref" == a ? c = t[a] : p[a] = t[a];
			var l = {
				type: e,
				props: p,
				key: n,
				ref: c,
				__k: null,
				__: null,
				__b: 0,
				__e: null,
				__c: null,
				constructor: void 0,
				__v: --o,
				__i: -1,
				__u: 0,
				__source: u,
				__self: i
			};
			if ("function" == typeof e && (c = e.defaultProps)) for (a in c) void 0 === p[a] && (p[a] = c[a]);
			return r.options.vnode && r.options.vnode(l), l;
		}
		var i = {};
		var c = /[A-Z]/g;
		Object.defineProperty(exports, "Fragment", {
			enumerable: !0,
			get: function() {
				return r.Fragment;
			}
		}), exports.jsx = u, exports.jsxAttr = function(e, o) {
			if (r.options.attr) {
				var f = r.options.attr(e, o);
				if ("string" == typeof f) return f;
			}
			if (o = function(r) {
				return null !== r && "object" == typeof r && "function" == typeof r.valueOf ? r.valueOf() : r;
			}(o), "ref" === e || "key" === e) return "";
			if ("style" === e && "object" == typeof o) {
				var u = "";
				for (var a in o) {
					var p = o[a];
					if (null != p && "" !== p) {
						var l = "-" == a[0] ? a : i[a] || (i[a] = a.replace(c, "-$&").toLowerCase()), s = ";";
						"number" != typeof p || l.startsWith("--") || n.test(l) || (s = "px;"), u = u + l + ":" + p + s;
					}
				}
				return e + "=\"" + t(u) + "\"";
			}
			return null == o || !1 === o || "function" == typeof o || "object" == typeof o ? "" : !0 === o ? e : e + "=\"" + t("" + o) + "\"";
		}, exports.jsxDEV = u, exports.jsxEscape = function r(e) {
			if (null == e || "boolean" == typeof e || "function" == typeof e) return null;
			if ("object" == typeof e) {
				if (void 0 === e.constructor) return e;
				if (f(e)) {
					for (var n = 0; n < e.length; n++) e[n] = r(e[n]);
					return e;
				}
			}
			return t("" + e);
		}, exports.jsxTemplate = function(e) {
			var t = u(r.Fragment, {
				tpl: e,
				exprs: [].slice.call(arguments, 1)
			});
			return t.key = t.__v, t;
		}, exports.jsxs = u;
	}));
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/design-bridge/hosted-subscription.tsx
	init_account_client();
	var import_jsxRuntime = require_jsxRuntime();
	/** Account billing is independent of provider keys, team billing and the chat model. */
	function HostedSubscriptionCard({ lang = "en", showSignIn = true }) {
		const [state, setState] = (0, import_hooks.useState)(subscriptionSnapshot);
		(0, import_hooks.useEffect)(() => {
			const stop = subscribeSubscription(() => setState(subscriptionSnapshot()));
			refreshSubscription();
			return stop;
		}, []);
		const text = (key, values) => subscriptionLabel(lang, key, values);
		const money = (micros) => new Intl.NumberFormat(lang, {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 2
		}).format(micros / 1e6);
		const subscription = state.account?.subscription, allowance = state.account?.allowance;
		const subscribed = Boolean(subscription && subscription.status !== "none" && subscription.status !== "canceled");
		const active = subscription?.status === "active";
		const canManage = Boolean(subscription && subscription.status !== "none");
		const remaining = allowance ? Math.max(0, allowance.limitMicros - allowance.usedMicros - allowance.reservedMicros) : 0;
		const offer = state.offer ?? publicSubscriptionOffer;
		const end = subscription?.currentPeriodEnd;
		const date = end ? new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(end)) : "";
		return /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("section", {
			class: "subscription-plan",
			"data-subscription-card": true,
			lang,
			dir: lang === "ar" ? "rtl" : "ltr",
			"aria-busy": state.loading || state.busy,
			children: [
				/* @__PURE__ */ (0, import_jsxRuntime.jsx)("h3", { children: text("title") }),
				/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
					class: "subscription-plan-grid",
					children: [/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("article", {
						class: "subscription-plan-free",
						"data-subscription-free": true,
						children: [
							/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("header", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("h4", { children: text("free") }), !state.loading && state.account && !subscribed && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("span", {
								class: "subscription-plan-badge",
								children: text("active")
							})] }),
							/* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: text("freeCopy") }),
							showSignIn && localAccountClient() && !publicAccountSnapshot()?.authenticated && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
								type: "button",
								disabled: state.busy,
								onClick: openSubscriptionAccount,
								children: accountLabel(lang, "signIn")
							})
						]
					}), /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("article", {
						class: "subscription-plan-plus",
						"data-subscription-plus": true,
						children: [
							/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("header", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("h4", {
								translate: false,
								children: "Plus"
							}), active && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("span", {
								class: "subscription-plan-badge",
								children: text("active")
							})] }),
							/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
								class: "subscription-plan-price",
								children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", { children: money(offer.amountMinor * 1e4) }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("span", { children: text("month") })]
							}),
							!subscribed && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: text("plusCopy") }),
							!allowance && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
								class: "subscription-plan-allowance",
								children: text("allowance", { amount: money(offer.allowanceMicros) })
							}),
							allowance && /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
								class: "subscription-plan-meter",
								children: [/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", { children: [text("remaining", { amount: money(remaining) }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("span", { children: text("allowance", { amount: money(allowance.limitMicros) }) })] }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("meter", {
									min: 0,
									max: allowance.limitMicros || 1,
									value: remaining,
									"aria-label": text("remaining", { amount: money(remaining) })
								})]
							}),
							end && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
								class: "subscription-plan-date",
								children: text(subscription?.cancelAtPeriodEnd || subscription?.status === "canceled" ? "ends" : "renews", { date })
							}),
							subscription?.status === "paused" && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: text("paused") }),
							subscription?.status === "canceled" && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: text("canceled") }),
							/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
								class: "subscription-plan-actions",
								children: [
									!subscribed && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
										type: "button",
										class: "subscription-plan-primary",
										disabled: state.busy || state.activationPending,
										onClick: () => void startPlusCheckout(),
										children: text(state.activationPending ? "activationPendingLabel" : state.pending ? "continue" : "getPlus")
									}),
									canManage && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
										type: "button",
										disabled: state.busy || state.loading,
										onClick: () => void openSubscriptionPortal(),
										children: text(subscription?.status === "past_due" ? "paymentDue" : "manage")
									}),
									subscribed && !subscription?.cancelAtPeriodEnd && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
										type: "button",
										class: "subscription-plan-cancel",
										disabled: state.busy || state.loading,
										onClick: () => void openSubscriptionPortal(),
										children: text("cancel")
									})
								]
							})
						]
					})]
				}),
				state.continuation && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("a", {
					class: "subscription-plan-resume",
					href: state.continuation,
					target: "_blank",
					rel: "noopener noreferrer",
					children: text("continue")
				}),
				state.error && /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
					class: "subscription-plan-feedback",
					role: "status",
					children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: text(state.error) }), state.error !== "activationPending" && /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						type: "button",
						disabled: state.busy || state.loading,
						onClick: () => void (state.error === "actionFailed" || state.error === "checkoutPending" ? startPlusCheckout() : state.error === "portalFailed" ? openSubscriptionPortal() : refreshSubscription()),
						children: text(state.error === "checkoutPending" ? "continue" : "retry")
					})]
				})
			]
		});
	}
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/webauthn-client.ts
	init_canonical();
	init_plain_data();
	async function authenticateSession(options, credentials = navigator.credentials, signal) {
		signal?.throwIfAborted();
		const credential = await credentials.get({
			signal,
			publicKey: {
				challenge: fromBase64url(options.challenge, 32, 32),
				rpId: options.rpId,
				timeout: options.timeout,
				userVerification: options.userVerification === "discouraged" || options.userVerification === "preferred" ? options.userVerification : "required",
				allowCredentials: options.allowCredentials?.map((item) => ({
					id: fromBase64url(item.id, 1, 2048),
					type: "public-key",
					transports: item.transports
				}))
			}
		});
		signal?.throwIfAborted();
		return serializeAssertion(credential);
	}
	function serializeAssertion(credential) {
		if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new Error("webauthn_cancelled_or_invalid");
		const attachment = credential.authenticatorAttachment;
		return {
			...projectCredentialIdentity(credential),
			type: "public-key",
			...attachment === "platform" || attachment === "cross-platform" ? { authenticatorAttachment: attachment } : {},
			clientExtensionResults: projectClientExtensions(credential.getClientExtensionResults()),
			response: {
				clientDataJSON: toBase64url(credential.response.clientDataJSON, 1, 65536),
				authenticatorData: toBase64url(credential.response.authenticatorData, 1, 65536),
				signature: toBase64url(credential.response.signature, 1, 65536),
				...credential.response.userHandle ? { userHandle: toBase64url(credential.response.userHandle, 0, 2048) } : {}
			}
		};
	}
	function toBase64url(value, minimum, maximum) {
		if (!(value instanceof ArrayBuffer) || value.byteLength < minimum || value.byteLength > maximum) throw new Error("webauthn_binary_invalid");
		const bytes = new Uint8Array(value);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
	}
	function projectCredentialIdentity(credential) {
		const rawId = toBase64url(credential.rawId, 1, 2048);
		if (credential.id !== rawId) throw new Error("webauthn_credential_identity_invalid");
		return {
			id: rawId,
			rawId
		};
	}
	function projectClientExtensions(value) {
		const projected = JSON.parse(canonicalJson(value));
		if (!isDataRecord(projected)) throw new Error("webauthn_extensions_invalid");
		return projected;
	}
	function fromBase64url(value, minimum, maximum) {
		if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("webauthn_base64url_invalid");
		const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
		let binary;
		try {
			binary = atob(normalized);
		} catch {
			throw new Error("webauthn_base64url_invalid");
		}
		const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (decoded.length < minimum || decoded.length > maximum || toBase64url(decoded.buffer, minimum, maximum) !== value) throw new Error("webauthn_base64url_invalid");
		return decoded;
	}
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/control-plane-projections.ts
	init_plain_data();
	function text(value, maximum) {
		return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : void 0;
	}
	function projectAuthOptions(value) {
		const root = asDataRecord(value), options = asDataRecord(root?.options), challengeId = typeof root?.challengeId === "string" && /^[0-9a-f-]{36}$/i.test(root.challengeId) ? root.challengeId : void 0;
		const challenge = text(options?.challenge, 256), rpId = text(options?.rpId, 253), timeout = options?.timeout;
		if (!root || !options || !challengeId || !challenge || !rpId || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3e5 || ![
			"required",
			"preferred",
			"discouraged"
		].includes(String(options.userVerification))) return void 0;
		return {
			challengeId,
			options: {
				challenge,
				rpId,
				timeout,
				userVerification: options.userVerification
			}
		};
	}
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/browser-response.ts
	init_limits();
	function readAuthOptionsResponse(response) {
		return projected(response, projectAuthOptions);
	}
	async function projected(response, projector) {
		const parsed = await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES);
		if (!parsed.ok) throw new Error(parsed.reason === "too_large" ? "browser_response_too_large" : "browser_response_invalid");
		const value = projector(parsed.value);
		if (value === void 0) throw new Error("browser_response_schema_invalid");
		return value;
	}
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/account-status-response.ts
	init_limits();
	init_plain_data();
	async function readAccountStatus(response) {
		const parsed = await readBoundedJson(response, 1024);
		if (response.status !== 200 || !parsed.ok || !isDataRecord(parsed.value) || Object.keys(parsed.value).join(",") !== "status" || parsed.value.status !== "recognized" && parsed.value.status !== "link_required") throw new Error("account_status_unavailable");
		return parsed.value.status;
	}
	//#endregion
	//#region quimera/uptokey/dashboard/src/lib/account-link-response.ts
	init_limits();
	init_plain_data();
	function isAccountDeviceId(value) {
		return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value);
	}
	function isAccountLinkConfirmation(value) {
		return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
	}
	async function readAccountLinkTarget(response) {
		const parsed = await readBoundedJson(response, 1024);
		const value = parsed.ok ? parsed.value : void 0;
		if (response.status !== 200 || !isDataRecord(value) || Object.keys(value).length !== 3 || !isAccountDeviceId(value.deviceId) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 80 || !isAccountLinkConfirmation(value.confirmation)) throw new Error("account_link_response_invalid");
		return {
			deviceId: value.deviceId,
			name: value.name,
			confirmation: value.confirmation
		};
	}
	async function readAccountLinked(response) {
		const parsed = await readBoundedJson(response, 1024);
		if (response.status !== 200 || !parsed.ok || !isDataRecord(parsed.value) || Object.keys(parsed.value).join(",") !== "status" || parsed.value.status !== "linked") throw new Error("account_link_response_invalid");
	}
	//#endregion
	//#region quimera/uptokey/uptokey-pwa/src/design-bridge/account.tsx
	init_billing_account();
	init_account_client();
	const accountAvailabilityErrors = /* @__PURE__ */ new Set([
		"account_service_unavailable",
		"account_unavailable",
		"account_client_unavailable"
	]);
	function ConnectedAccount({ lang, getLocalToken, embedded = false, compact = false, headless = false, view = "account", onFeedback, onResumeLogin, onLoginComplete, onConnectHosted, connectHostedLabel }) {
		const [usageOpen, setUsageOpen] = (0, import_hooks.useState)(view === "usage"), [usageMounted, setUsageMounted] = (0, import_hooks.useState)(view === "usage");
		(0, import_hooks.useEffect)(() => {
			if (view === "usage") {
				setUsageOpen(true);
				setUsageMounted(true);
			}
		}, [view]);
		const [locale, setLocale] = (0, import_hooks.useState)(lang), [session, setSession] = (0, import_hooks.useState)(publicAccountSnapshot()), [access, setAccess] = (0, import_hooks.useState)("not_checked"), [linked, setLinked] = (0, import_hooks.useState)("not_checked"), [error, setError] = (0, import_hooks.useState)(""), [notice, setNotice] = (0, import_hooks.useState)(null), [busy, setBusy] = (0, import_hooks.useState)(false), [target, setTarget] = (0, import_hooks.useState)(), [passkeyOrigin, setPasskeyOrigin] = (0, import_hooks.useState)(""), [pending, setPending] = (0, import_hooks.useState)(null);
		const controller = (0, import_hooks.useRef)(), working = (0, import_hooks.useRef)(false), tokenGetter = (0, import_hooks.useRef)(getLocalToken);
		tokenGetter.current = getLocalToken;
		const root = (0, import_hooks.useRef)(null), shareFocus = (0, import_hooks.useRef)(), [available, setAvailable] = (0, import_hooks.useState)(null), [choices, setChoices] = (0, import_hooks.useState)([]), [sharePending, setSharePending] = (0, import_hooks.useState)(null), [requests, setRequests] = (0, import_hooks.useState)([]);
		const shareWaitController = (0, import_hooks.useRef)(), shareCommit = (0, import_hooks.useRef)(false), [shareCommitting, setShareCommitting] = (0, import_hooks.useState)(false);
		const menuSignIn = (0, import_hooks.useRef)();
		const [usage, setUsage] = (0, import_hooks.useState)(null), [usageRevision, setUsageRevision] = (0, import_hooks.useState)(0);
		const recoverableError = (0, import_hooks.useRef)(""), returnLogin = (0, import_hooks.useRef)();
		const label = (key) => accountLabel(locale, key);
		const observe = (value) => {
			setSession(value);
			const returning = returnLogin.current;
			if (value?.authenticated && returning) {
				returnLogin.current = void 0;
				if (!controller.current?.signal.aborted && Date.now() < returning.expiresAt) onLoginComplete?.(returning.loginUrl);
			} else if (value?.state === "signed_out") returnLogin.current = void 0;
			if (value?.authenticated || value?.state === "signed_out") setPending(null);
			if (value?.configured || value?.state === "unavailable") setNotice((current) => current === "unconfigured" ? null : current);
			if (value?.configured && value.state !== "unavailable" && recoverableError.current) {
				const previous = recoverableError.current;
				recoverableError.current = "";
				setError((current) => current === previous ? "" : current);
			}
		};
		const accept = (value) => {
			observe(value);
			publishAccountState(value);
		};
		const restoreFocus = (target) => window.requestAnimationFrame(() => {
			const current = document.activeElement;
			if (current !== document.body && !root.current?.contains(current)) return;
			if (target?.isConnected && !target.matches(":disabled")) target.focus();
			else root.current?.querySelector("[data-account-actions] button:not(:disabled)")?.focus();
		});
		const refresh = async (signal) => {
			const value = await readUptokeyAccount(tokenGetter.current, signal);
			if (!signal?.aborted) {
				if (value.authenticated && session?.authenticated) setUsageRevision((n) => n + 1);
				accept(value);
				setNotice(value.configured || value.state === "unavailable" ? null : "unconfigured");
			}
		};
		(0, import_hooks.useEffect)(() => setLocale(lang), [lang]);
		(0, import_hooks.useEffect)(() => {
			const request = new AbortController();
			if (!session?.authenticated) {
				setUsage(null);
				return;
			}
			readUptokeyUsage(tokenGetter.current, request.signal).then((value) => {
				if (!request.signal.aborted) setUsage(value);
			}).catch(() => {});
			return () => request.abort();
		}, [session?.authenticated, usageRevision]);
		(0, import_hooks.useEffect)(() => {
			const next = new AbortController();
			controller.current = next;
			const update = (event) => {
				const value = event.detail?.locale;
				if (accountLocales.includes(value)) setLocale(value);
			};
			const state = () => observe(publicAccountSnapshot());
			const workspace = (event) => {
				if (event.detail?.state === "ended") {
					returnLogin.current = void 0;
					setPending(null);
					setSharePending(null);
					setChoices([]);
					setAvailable(null);
					setRequests([]);
					setNotice("signedOut");
				}
			};
			const login = () => {
				const request = takeAccountMenuLogin();
				if (request) menuSignIn.current?.(request.popup);
			};
			window.addEventListener("uptokey:locale", update);
			window.addEventListener("uptokey:account-state", state);
			window.addEventListener("uptokey:workspace-session", workspace);
			window.addEventListener("uptokey:account-login-request", login);
			login();
			return () => {
				next.abort();
				window.removeEventListener("uptokey:locale", update);
				window.removeEventListener("uptokey:account-state", state);
				window.removeEventListener("uptokey:workspace-session", workspace);
				window.removeEventListener("uptokey:account-login-request", login);
			};
		}, []);
		const shareError = (code) => {
			if (code === "account_share_conflict") setNotice("shareConflict");
			else if (code === "account_share_denied") setNotice("shareDenied");
			else if (code === "account_share_expired") setNotice("shareExpired");
			else setError(code);
		};
		const run = async (action, recoverAvailability = false) => {
			if (working.current || shareCommit.current || !controller.current || controller.current.signal.aborted) return;
			const focused = document.activeElement instanceof HTMLElement ? document.activeElement : void 0;
			working.current = true;
			setBusy(true);
			setError("");
			recoverableError.current = "";
			setNotice(null);
			try {
				await action(controller.current.signal);
			} catch (value) {
				if (value instanceof DOMException && value.name === "AbortError") return;
				if (!controller.current.signal.aborted) {
					const code = value instanceof Error && /^[a-z][a-z0-9_]{0,99}$/.test(value.message) ? value.message : "account_unavailable";
					if ([
						"unconfigured",
						"account_not_configured",
						"account_service_not_configured"
					].includes(code)) setNotice("unconfigured");
					else if (value instanceof DOMException && value.name === "NotAllowedError") setNotice("cancelled");
					else if (code === "passkey_localhost_required") setNotice("originHint");
					else if (code.startsWith("account_share_")) shareError(code);
					else {
						if (recoverAvailability && accountAvailabilityErrors.has(code)) {
							recoverableError.current = code;
							const previous = publicAccountSnapshot();
							accept({
								configured: previous?.configured ?? false,
								loginAvailable: previous?.loginAvailable ?? false,
								authenticated: false,
								state: "unavailable",
								source: desktopAccount() ? "desktop" : "web"
							});
						}
						setError(code);
					}
				}
			} finally {
				working.current = false;
				if (!controller.current.signal.aborted) {
					setBusy(false);
					restoreFocus(focused);
				}
			}
		};
		(0, import_hooks.useEffect)(() => {
			if (!pending) return;
			const next = new AbortController();
			let polling = false;
			const expire = () => {
				next.abort();
				setPending(null);
				setNotice("shareExpired");
			};
			const poll = () => {
				if (next.signal.aborted) return;
				if (Date.now() >= pending.expiresAt) {
					expire();
					return;
				}
				if (working.current || polling) return;
				polling = true;
				refresh(next.signal).catch(() => {}).finally(() => {
					polling = false;
				});
			};
			const timer = window.setTimeout(expire, Math.max(0, pending.expiresAt - Date.now())), interval = window.setInterval(poll, 2500);
			window.addEventListener("focus", poll);
			return () => {
				next.abort();
				window.clearTimeout(timer);
				window.clearInterval(interval);
				window.removeEventListener("focus", poll);
			};
		}, [pending]);
		const signIn = (popup) => {
			if (working.current || sharePending) {
				popup?.close();
				return;
			}
			if (pending) {
				popup?.close();
				run(async (signal) => {
					if (!onResumeLogin) return;
					const current = await onResumeLogin(pending, signal);
					if (signal.aborted) return;
					if (current) {
						accept(current);
						if (!current.configured) setNotice("unconfigured");
					} else setNotice("connecting");
				}, true);
				return;
			}
			const tab = popup !== void 0 ? popup : !desktopAccount() && tokenGetter.current ? window.open("about:blank", "_blank") : void 0;
			if (tab) tab.opener = null;
			run(async (signal) => {
				try {
					setChoices([]);
					const bindingRevision = accountBindingRevision();
					const answer = await startUptokeyLogin(locale, tokenGetter.current, signal, tab, (challenge) => {
						signal.throwIfAborted();
						if (bindingRevision !== accountBindingRevision()) throw new DOMException("account_request_superseded", "AbortError");
						returnLogin.current = challenge;
						setPending({
							...challenge,
							bindingRevision
						});
						setNotice("connecting");
					});
					if (signal.aborted) {
						tab?.close();
						return;
					}
					if (answer.session) {
						accept(answer.session);
						if (!answer.session.configured && answer.session.state !== "unavailable") setNotice("unconfigured");
					}
				} catch (error) {
					tab?.close();
					throw error;
				}
			}, true);
		};
		menuSignIn.current = signIn;
		const adopt = async (entry, revision, signal) => {
			signal.throwIfAborted();
			shareCommit.current = true;
			setShareCommitting(true);
			try {
				const answer = await adoptUptokeyAccount(entry.accountRef, revision, tokenGetter.current, signal);
				if (signal.aborted) return;
				if (!answer.session.authenticated) throw Error("account_share_denied");
				setAvailable(null);
				setChoices([]);
				accept({
					...answer.session,
					source: desktopAccount() ? "desktop" : "web"
				});
			} finally {
				shareCommit.current = false;
				setShareCommitting(false);
			}
		};
		const useComputer = () => {
			if (pending || sharePending) return;
			shareFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : void 0;
			run(async (signal) => {
				const answer = await readAvailableUptokeyAccounts(tokenGetter.current, signal);
				if (signal.aborted) return;
				setAvailable(answer);
				if (answer.accounts.length === 1) {
					await adopt(answer.accounts[0], answer.revision, signal);
					return;
				}
				if (answer.accounts.length) {
					setChoices(answer.accounts);
					return;
				}
				const request = await requestUptokeyAccountAccess(tokenGetter.current, signal);
				if (!signal.aborted) setSharePending(request);
			});
		};
		(0, import_hooks.useEffect)(() => {
			if (headless || !session?.authenticated || !tokenGetter.current) {
				setAvailable(null);
				setRequests([]);
				return;
			}
			const next = new AbortController();
			let polling = false;
			const poll = () => {
				if (polling || working.current || next.signal.aborted) return;
				polling = true;
				(async () => {
					const answer = await readAvailableUptokeyAccounts(tokenGetter.current, next.signal);
					if (next.signal.aborted) return;
					setAvailable(answer);
					if (answer.currentAccountRef === null) {
						const verified = await readUptokeyAccount(tokenGetter.current, next.signal);
						if (!next.signal.aborted) accept(verified);
					}
					if (answer.currentOwned) {
						const pendingRequests = await readUptokeyAccountRequests(tokenGetter.current, next.signal);
						if (!next.signal.aborted) setRequests(pendingRequests.requests);
					} else setRequests([]);
				})().catch(() => {
					if (!next.signal.aborted) setRequests([]);
				}).finally(() => {
					polling = false;
				});
			};
			poll();
			const interval = window.setInterval(poll, 5e3);
			window.addEventListener("focus", poll);
			return () => {
				next.abort();
				window.clearInterval(interval);
				window.removeEventListener("focus", poll);
			};
		}, [
			headless,
			session?.authenticated,
			usageRevision
		]);
		(0, import_hooks.useEffect)(() => {
			if (!sharePending) return;
			const next = new AbortController();
			shareWaitController.current = next;
			let polling = false, finished = false, approved = false;
			const finish = (message) => {
				if (finished) return;
				finished = true;
				next.abort();
				setSharePending(null);
				if (message) setNotice(message);
				restoreFocus(shareFocus.current);
			};
			const expire = () => {
				if (!approved) finish("shareExpired");
			};
			const poll = () => {
				if (next.signal.aborted) return;
				if (!approved && Date.now() >= Date.parse(sharePending.expiresAt)) {
					expire();
					return;
				}
				if (polling || working.current) return;
				polling = true;
				(async () => {
					await consumeUptokeyAccountAccess(sharePending.id, tokenGetter.current, next.signal);
					if (next.signal.aborted) return;
					approved = true;
					window.clearTimeout(timer);
					const answer = await readAvailableUptokeyAccounts(tokenGetter.current, next.signal);
					if (next.signal.aborted) return;
					setAvailable(answer);
					if (answer.accounts.length === 1) await adopt(answer.accounts[0], answer.revision, next.signal);
					else if (answer.accounts.length) setChoices(answer.accounts);
					else throw Error("account_share_denied");
					if (!next.signal.aborted) finish();
				})().catch((value) => {
					if (next.signal.aborted) return;
					const code = value instanceof Error ? value.message : "account_unavailable";
					if (code === "account_share_pending" || value instanceof DOMException && value.name === "AbortError") return;
					finish();
					if (code.startsWith("account_share_")) shareError(code);
					else setError(code);
				}).finally(() => {
					polling = false;
				});
			};
			const timer = window.setTimeout(expire, Math.max(0, Date.parse(sharePending.expiresAt) - Date.now())), interval = window.setInterval(poll, 2500);
			window.addEventListener("focus", poll);
			return () => {
				next.abort();
				if (shareWaitController.current === next) shareWaitController.current = void 0;
				window.clearTimeout(timer);
				window.clearInterval(interval);
				window.removeEventListener("focus", poll);
			};
		}, [sharePending]);
		const refreshDevice = async (signal) => {
			const [device, identity] = await Promise.allSettled([getBillingAccount(), accountFetch("/api/account/status", { signal }).then(readAccountStatus)]);
			if (signal?.aborted) return;
			setAccess(device.status === "fulfilled" ? device.value.state : "unavailable");
			setLinked(identity.status === "fulfilled" ? identity.value : "unavailable");
		};
		const connectDevice = () => run(async (signal) => {
			const options = await readAuthOptionsResponse(await accountFetch("/api/session/options", {
				method: "POST",
				signal
			}));
			if (["127.0.0.1", "[::1]"].includes(window.location.hostname) && options.options.rpId === "localhost") {
				const url = new URL(window.location.href);
				url.hostname = "localhost";
				setPasskeyOrigin(url.href);
				throw Error("passkey_localhost_required");
			}
			const assertion = await authenticateSession(options.options, void 0, signal);
			if ((await (await accountFetch("/api/session/verify", {
				method: "POST",
				signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					challengeId: options.challengeId,
					assertion
				})
			})).json()).authenticated !== true) throw Error("authentication_rejected");
			window.dispatchEvent(new Event("uptokey:session-ready"));
			await refreshDevice(signal);
		});
		const disconnectDevice = () => run(async (signal) => {
			if ((await accountFetch("/api/session/logout", {
				method: "POST",
				signal
			})).status !== 204) throw Error("session_disconnect_unconfirmed");
			setTarget(void 0);
			setAccess("signed_out");
			window.dispatchEvent(new Event("uptokey:session-ended"));
		});
		const names = {
			not_checked: "notChecked",
			connected: "connected",
			signed_out: "signedOut",
			recognized: "recognized",
			link_required: "linkRequired",
			unconfigured: "unconfigured",
			unavailable: "unknown"
		};
		const errorLabel = error === "authentication_rejected" ? "rejected" : error === "session_disconnect_unconfirmed" ? "disconnectFailed" : /^account_link|link_/.test(error) ? "linkFailed" : "unavailable";
		const accountUnavailable = session?.state === "unavailable";
		const status = pending ? null : session?.authenticated ? "accountConnected" : session?.state === "unavailable" ? "unavailable" : session?.requiresSignIn ? "reconnectAccount" : session ? session.configured ? "signedOut" : "unconfigured" : null;
		(0, import_hooks.useEffect)(() => {
			if (headless && (error || notice && [
				"unconfigured",
				"cancelled",
				"originHint",
				"shareExpired"
			].includes(notice))) onFeedback?.(error ? errorLabel : notice);
		}, [
			headless,
			error,
			notice,
			onFeedback
		]);
		if (headless) return null;
		return /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("section", {
			ref: root,
			class: "sb-section",
			"data-testid": "account-panel",
			"aria-busy": busy || shareCommitting,
			children: [
				!embedded ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("h2", { children: label("title") }) : null,
				!compact && !session?.authenticated ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
					"data-account-optional": true,
					children: label("optional")
				}) : null,
				status && (!compact || !["signedOut", "accountConnected"].includes(status)) && (!error || status !== errorLabel) ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
					role: "status",
					children: label(status)
				}) : null,
				session?.authenticated && session.profile ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", {
					"data-account-profile": true,
					children: [
						session.profile.displayName ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", { children: session.profile.displayName }) : null,
						session.profile.email ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("span", { children: [" ", session.profile.email] }) : null,
						session.profile.plan === "free" ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("span", {
							"data-account-plan": true,
							children: [" · ", label("freePlan")]
						}) : null
					]
				}) : null,
				compact ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)(import_jsxRuntime.Fragment, { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("div", {
					class: "settings-actions",
					"data-account-actions": true,
					"data-account-primary": true,
					children: !session?.authenticated ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						class: accountUnavailable ? "settings-button" : "settings-button settings-button-prominent",
						disabled: busy || shareCommitting || Boolean(pending) || Boolean(sharePending),
						onClick: () => signIn(),
						children: label("signIn")
					}) : null
				}), /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("details", {
					class: "account-secondary",
					"data-account-options": true,
					children: [
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("summary", { children: label("menuSettings") }),
						!session?.authenticated ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: label("optional") }) : null,
						"  ",
						/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
							class: "settings-actions",
							"data-account-actions": true,
							children: [
								!session?.authenticated && getLocalToken ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
									class: accountUnavailable ? "settings-button" : "settings-button settings-button-prominent",
									disabled: busy || shareCommitting || Boolean(pending) || Boolean(sharePending),
									onClick: useComputer,
									children: label("useComputer")
								}) : null,
								/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
									class: accountUnavailable ? "settings-button settings-button-prominent" : "settings-button",
									"data-account-refresh": true,
									disabled: busy || shareCommitting,
									onClick: () => run(refresh, true),
									children: label("refresh")
								}),
								session?.authenticated && available?.currentOwned === false ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
									class: "settings-button",
									"data-action-tone": "exit",
									"data-account-unlink": true,
									disabled: busy || shareCommitting,
									onClick: () => run(async (signal) => {
										const next = await unlinkUptokeyAccount(available.revision, tokenGetter.current, signal);
										if (!signal.aborted) {
											setAvailable(null);
											setChoices([]);
											accept({
												...next.session,
												source: desktopAccount() ? "desktop" : "web"
											});
										}
									}),
									children: label("disconnectClient")
								}) : null,
								session?.authenticated && (!getLocalToken || available?.currentOwned === true) ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
									class: "settings-button",
									"data-action-tone": "exit",
									"data-account-end": true,
									disabled: busy || shareCommitting,
									onClick: () => run(async (signal) => {
										const next = await endUptokeyAccount(tokenGetter.current, signal);
										if (next && !signal.aborted) accept(next);
									}),
									children: label(getLocalToken ? "endAccount" : "signOut")
								}) : null
							]
						}),
						session?.authenticated && onConnectHosted ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: "settings-button",
							"data-account-connect-models": true,
							disabled: busy || shareCommitting || Boolean(pending) || Boolean(sharePending),
							onClick: () => run(async (signal) => {
								await onConnectHosted(signal);
								if (!signal.aborted) setNotice("connecting");
							}),
							children: connectHostedLabel?.(locale)
						}) : null
					]
				})] }) : /* @__PURE__ */ (0, import_jsxRuntime.jsxs)(import_jsxRuntime.Fragment, { children: ["  ", /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
					class: "settings-actions",
					"data-account-actions": true,
					children: [
						!session?.authenticated && getLocalToken ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: accountUnavailable ? "settings-button" : "settings-button settings-button-prominent",
							disabled: busy || shareCommitting || Boolean(pending) || Boolean(sharePending),
							onClick: useComputer,
							children: label("useComputer")
						}) : null,
						!session?.authenticated ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: getLocalToken || accountUnavailable ? "settings-button" : "settings-button settings-button-prominent",
							disabled: busy || shareCommitting || Boolean(pending) || Boolean(sharePending),
							onClick: () => signIn(),
							children: label("signIn")
						}) : null,
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: accountUnavailable ? "settings-button settings-button-prominent" : "settings-button",
							"data-account-refresh": true,
							disabled: busy || shareCommitting,
							onClick: () => run(refresh, true),
							children: label("refresh")
						}),
						session?.authenticated && available?.currentOwned === false ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: "settings-button",
							"data-action-tone": "exit",
							"data-account-unlink": true,
							disabled: busy || shareCommitting,
							onClick: () => run(async (signal) => {
								const next = await unlinkUptokeyAccount(available.revision, tokenGetter.current, signal);
								if (!signal.aborted) {
									setAvailable(null);
									setChoices([]);
									accept({
										...next.session,
										source: desktopAccount() ? "desktop" : "web"
									});
								}
							}),
							children: label("disconnectClient")
						}) : null,
						session?.authenticated && (!getLocalToken || available?.currentOwned === true) ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: "settings-button",
							"data-action-tone": "exit",
							"data-account-end": true,
							disabled: busy || shareCommitting,
							onClick: () => run(async (signal) => {
								const next = await endUptokeyAccount(tokenGetter.current, signal);
								if (next && !signal.aborted) accept(next);
							}),
							children: label(getLocalToken ? "endAccount" : "signOut")
						}) : null
					]
				})] }),
				choices.length && available ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
					"data-account-choices": true,
					children: [
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", { children: label("accountChoice") }),
						choices.map((entry) => /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: "settings-button",
							disabled: busy || shareCommitting,
							onClick: () => run((signal) => adopt(entry, available.revision, signal)),
							children: entry.session.profile?.displayName ?? entry.session.profile?.email ?? label("title")
						}, entry.accountRef)),
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							class: "settings-button",
							disabled: busy || shareCommitting,
							onClick: () => {
								setChoices([]);
								setNotice("cancelled");
								restoreFocus(shareFocus.current);
							},
							children: label("cancel")
						})
					]
				}) : null,
				sharePending ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
					"data-account-share-pending": true,
					children: [/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", {
						role: "status",
						children: [
							label("shareWaiting"),
							" ",
							/* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", {
								dir: "ltr",
								children: sharePending.userCode
							})
						]
					}), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						class: "settings-button",
						disabled: shareCommitting,
						onClick: () => {
							if (shareCommit.current) return;
							shareWaitController.current?.abort();
							setSharePending(null);
							setNotice(null);
							restoreFocus(shareFocus.current);
						},
						children: label("cancel")
					})]
				}) : null,
				requests.length && available?.currentOwned === true ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("div", {
					"data-account-share-requests": true,
					children: requests.map((request) => /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", { children: [
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", { children: request.clientName }),
						" ",
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("span", {
							dir: "ltr",
							children: request.audience
						}),
						" ",
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", {
							dir: "ltr",
							children: request.userCode
						})
					] }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						class: "settings-button",
						disabled: busy || shareCommitting,
						onClick: () => run(async (signal) => {
							const source = available.accounts.find((entry) => entry.owned && entry.accountRef === available.currentAccountRef);
							if (!source) throw Error("account_share_conflict");
							await approveUptokeyAccountAccess(request.id, request.userCode, source.accountRef, tokenGetter.current, signal);
							if (!signal.aborted) setRequests((current) => current.filter((row) => row.id !== request.id));
						}),
						children: label("approveAccount")
					})] }, request.id))
				}) : null,
				pending ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", {
					role: "status",
					"data-account-pending": true,
					children: [
						label("connecting"),
						" ",
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", {
							dir: "ltr",
							children: pending.userCode
						}),
						pending.loginUrl ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("a", {
							href: pending.loginUrl,
							target: "_blank",
							rel: "noopener noreferrer",
							children: [" ", label("signIn")]
						}) : null
					]
				}) : null,
				compact ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("details", {
					class: "account-secondary",
					"data-account-usage": true,
					open: usageOpen,
					onToggle: (event) => {
						const open = event.currentTarget.open;
						setUsageOpen(open);
						if (open) setUsageMounted(true);
					},
					children: [
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("summary", { children: label("menuUsage") }),
						session?.authenticated && usage ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
							"data-account-balance": true,
							children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("h3", { children: label("cloudBalance") }), usage.state === "observed" ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)(import_jsxRuntime.Fragment, { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("dl", { children: [
								"availableMicros",
								"reservedMicros",
								"spentMicros"
							].map((key, index) => /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("dt", { children: label([
								"balanceAvailable",
								"balanceReserved",
								"balanceSpent"
							][index]) }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("dd", { children: new Intl.NumberFormat(locale, {
								style: "currency",
								currency: "USD",
								maximumFractionDigits: 6
							}).format(usage[key] / 1e6) })] })) }), /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", { children: [
								label("balanceMeasured"),
								" ",
								new Intl.DateTimeFormat(locale, {
									dateStyle: "medium",
									timeStyle: "short"
								}).format(new Date(usage.verifiedAt))
							] })] }) : /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
								role: "status",
								children: label(usage.state === "not_configured" ? "balanceUnconfigured" : usage.state === "link_required" ? "balanceLinkRequired" : usage.state === "reauthentication_required" ? "signedOut" : "balanceUnavailable")
							})]
						}) : null,
						usageMounted ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)(HostedSubscriptionCard, {
							showSignIn: false,
							lang: accountLocales.includes(locale) ? locale : "en"
						}) : null
					]
				}) : /* @__PURE__ */ (0, import_jsxRuntime.jsxs)(import_jsxRuntime.Fragment, { children: [session?.authenticated && usage ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", {
					"data-account-balance": true,
					children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("h3", { children: label("cloudBalance") }), usage.state === "observed" ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)(import_jsxRuntime.Fragment, { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("dl", { children: [
						"availableMicros",
						"reservedMicros",
						"spentMicros"
					].map((key, index) => /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("dt", { children: label([
						"balanceAvailable",
						"balanceReserved",
						"balanceSpent"
					][index]) }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("dd", { children: new Intl.NumberFormat(locale, {
						style: "currency",
						currency: "USD",
						maximumFractionDigits: 6
					}).format(usage[key] / 1e6) })] })) }), /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", { children: [
						label("balanceMeasured"),
						" ",
						new Intl.DateTimeFormat(locale, {
							dateStyle: "medium",
							timeStyle: "short"
						}).format(new Date(usage.verifiedAt))
					] })] }) : /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
						role: "status",
						children: label(usage.state === "not_configured" ? "balanceUnconfigured" : usage.state === "link_required" ? "balanceLinkRequired" : usage.state === "reauthentication_required" ? "signedOut" : "balanceUnavailable")
					})]
				}) : null, /* @__PURE__ */ (0, import_jsxRuntime.jsx)(HostedSubscriptionCard, {
					showSignIn: false,
					lang: accountLocales.includes(locale) ? locale : "en"
				})] }),
				!desktopAccount() ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("details", { children: [
					/* @__PURE__ */ (0, import_jsxRuntime.jsx)("summary", { children: label("deviceBinding") }),
					access !== "not_checked" ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
						role: "status",
						children: label(names[access] ?? "unknown")
					}) : null,
					/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						disabled: busy || shareCommitting,
						onClick: connectDevice,
						children: label("connect")
					}),
					/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						"data-action-tone": "exit",
						disabled: busy || shareCommitting || access !== "connected",
						onClick: disconnectDevice,
						children: label("disconnect")
					}),
					/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						disabled: busy || shareCommitting,
						onClick: () => run(refreshDevice),
						children: label("refresh")
					}),
					linked !== "not_checked" ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
						role: "status",
						children: label(names[linked] ?? "unknown")
					}) : null,
					(linked === "recognized" || linked === "link_required") && access === "connected" ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
						disabled: busy || shareCommitting,
						onClick: () => run(async (signal) => setTarget(await readAccountLinkTarget(await accountFetch("/api/account/link-target", { signal })))),
						children: label("link")
					}) : null,
					target ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, import_jsxRuntime.jsxs)("p", { children: [
							label("confirmPrompt"),
							" ",
							/* @__PURE__ */ (0, import_jsxRuntime.jsx)("strong", { children: target.name })
						] }),
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							disabled: busy || shareCommitting,
							onClick: () => run(async (signal) => {
								await readAccountLinked(await accountFetch("/api/account/link", {
									method: "POST",
									signal,
									headers: { "content-type": "application/json" },
									body: JSON.stringify({
										expectedDeviceId: target.deviceId,
										confirmation: target.confirmation
									})
								}));
								setTarget(void 0);
								await refreshDevice(signal);
							}),
							children: label("confirm")
						}),
						/* @__PURE__ */ (0, import_jsxRuntime.jsx)("button", {
							disabled: busy || shareCommitting,
							onClick: () => setTarget(void 0),
							children: label("cancel")
						})
					] }) : null,
					passkeyOrigin ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("a", {
						class: "settings-button",
						href: passkeyOrigin,
						children: label("localOrigin")
					}) : null
				] }) : null,
				notice && !pending && notice !== status ? /* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
					role: "status",
					children: label(notice)
				}) : null,
				error ? /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("p", {
					role: "alert",
					children: label(errorLabel)
				}), /* @__PURE__ */ (0, import_jsxRuntime.jsxs)("details", { children: [/* @__PURE__ */ (0, import_jsxRuntime.jsx)("summary", { children: label("technical") }), /* @__PURE__ */ (0, import_jsxRuntime.jsx)("code", {
					translate: false,
					children: error
				})] })] }) : null
			]
		});
	}
	//#endregion
	//#region \0uptokey-account-entry
	init_account_client();
	init_interaction_effects();
	init_account_native();
	function subscribeAccountCatalogRefresh(listener) {
		return subscribeInteractionRefresh(["account"], listener);
	}
	const connectLabels = {
		"en": "Connect models",
		"pt-BR": "Conectar modelos",
		"es": "Conectar modelos",
		"fr": "Connecter les modèles",
		"de": "Modelle verbinden",
		"it": "Collega modelli",
		"ja": "モデルを接続",
		"ko": "모델 연결",
		"zh-CN": "连接模型",
		"ar": "ربط النماذج"
	};
	function UpgradeAction({ lang }) {
		const [state, setState] = (0, import_hooks.useState)(subscriptionSnapshot);
		(0, import_hooks.useEffect)(() => {
			const stop = subscribeSubscription(() => setState(subscriptionSnapshot()));
			refreshSubscription();
			return stop;
		}, []);
		const status = state.account?.subscription?.status;
		if (status && status !== "none" && status !== "canceled") return null;
		return (0, import_preact.h)("button", {
			type: "button",
			class: "uptokey-plus-cta",
			"data-uptokey-plus": "",
			disabled: state.busy || state.activationPending,
			onClick: () => void startPlusCheckout(),
			"aria-label": subscriptionLabel(lang, "getPlus")
		}, (0, import_preact.h)("span", {
			"aria-hidden": "true",
			class: "uptokey-plus-spark"
		}, "✦"), (0, import_preact.h)("span", { class: "uptokey-plus-label" }, subscriptionLabel(lang, "getPlus")), (0, import_preact.h)("span", {
			"aria-hidden": "true",
			class: "uptokey-plus-arrow"
		}, "↗"));
	}
	function mountUpgrade(target, lang) {
		(0, import_preact.render)((0, import_preact.h)(UpgradeAction, { lang }), target);
		return () => (0, import_preact.render)(null, target);
	}
	function completeLogin(url) {
		window.UptokeyDesktop?.completeAccountLogin?.(url).catch(() => {});
	}
	async function resumeLogin(pending, signal) {
		const revision = accountBindingRevision();
		const admit = () => {
			signal.throwIfAborted();
			if (revision !== pending.bindingRevision || revision !== accountBindingRevision()) throw new DOMException("account_request_superseded", "AbortError");
		};
		admit();
		const session = await readUptokeyAccount(async () => "", signal);
		admit();
		if (session.authenticated || !session.configured || !session.loginAvailable || session.state !== "connecting") return session;
		if (Date.now() >= pending.expiresAt) throw Error("account_share_expired");
		if (!pending.loginUrl || !window.UptokeyDesktop?.openAccountLogin) throw Error("account_browser_unavailable");
		admit();
		await window.UptokeyDesktop.openAccountLogin(pending.loginUrl);
		admit();
		return null;
	}
	async function connectHosted(signal) {
		const revision = accountBindingRevision();
		const admit = () => {
			signal.throwIfAborted();
			if (accountBindingRevision() !== revision || !publicAccountSnapshot()?.authenticated) throw new DOMException("account_request_superseded", "AbortError");
		};
		admit();
		const answer = await window.UptokeyHarnessAccount.request("connection", {});
		admit();
		if (answer?.status !== 200) throw Error("account_unavailable");
		const { loginUrl } = readAccountConnectionResponse(answer.body, { expectedOrigin: "https://app.uptokey.com" });
		if (!window.UptokeyDesktop?.openAccountLogin) throw Error("account_browser_unavailable");
		admit();
		await window.UptokeyDesktop.openAccountLogin(loginUrl);
		admit();
	}
	function mountPanel(target, options) {
		let current = options, active = true, visibleRequest = new AbortController();
		const paint = (next) => {
			if (!active) return;
			if (next.headless === true && current.headless !== true) {
				visibleRequest.abort();
				visibleRequest = new AbortController();
			}
			current = {
				...current,
				...next
			};
			(0, import_preact.render)((0, import_preact.h)(ConnectedAccount, {
				...current,
				getLocalToken: async () => "",
				embedded: true,
				onResumeLogin: resumeLogin,
				onLoginComplete: completeLogin,
				onConnectHosted: (signal) => connectHosted(AbortSignal.any([signal, visibleRequest.signal])),
				connectHostedLabel: (locale) => connectLabels[locale] ?? connectLabels.en
			}), target);
		};
		paint(options);
		const dispose = () => {
			if (!active) return;
			active = false;
			visibleRequest.abort();
			(0, import_preact.render)(null, target);
		};
		dispose.update = paint;
		return dispose;
	}
	//#endregion
	exports.accountBindingRevision = accountBindingRevision;
	exports.accountLabel = accountLabel;
	exports.accountLocales = accountLocales;
	exports.bootAccountState = bootAccountState;
	exports.mountAccountRail = mountAccountRail;
	exports.mountPanel = mountPanel;
	exports.mountUpgrade = mountUpgrade;
	exports.publicAccountSnapshot = publicAccountSnapshot;
	exports.subscribeAccountBinding = subscribeAccountBinding;
	exports.subscribeAccountCatalogRefresh = subscribeAccountCatalogRefresh;
	return exports;
})({});
