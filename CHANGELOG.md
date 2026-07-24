# Changelog

All notable changes to Koine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Koine is pre-1.0, so minor versions
may include breaking changes.

## [0.251.0](https://github.com/Atypical-Consulting/Koine/compare/v0.250.0...v0.251.0) (2026-07-24)


### Features

* **studio:** derive the keybinding conflict-check from the live editor keymap ([#431](https://github.com/Atypical-Consulting/Koine/issues/431)) ([#1413](https://github.com/Atypical-Consulting/Koine/issues/1413)) ([7f745e7](https://github.com/Atypical-Consulting/Koine/commit/7f745e73253a95b5a13dad7c1e7c5ec3c68ae14e))
* **studio:** explorer batch — bulk buffers, rebindable keybindings, and five Preact panel migrations ([#1416](https://github.com/Atypical-Consulting/Koine/issues/1416)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** grow useEditableField with transient-session mode + adopt in ExplorerPanel ([#1396](https://github.com/Atypical-Consulting/Koine/issues/1396)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** light up Source Control ⋮/caret menus for Discard/Pull/Push/Fetch/Amend/Commit&Push ([#1401](https://github.com/Atypical-Consulting/Koine/issues/1401)) ([#1453](https://github.com/Atypical-Consulting/Koine/issues/1453)) ([2a809bc](https://github.com/Atypical-Consulting/Koine/commit/2a809bcbed41d19db6cf33d9c907d65a2d25951f))
* **studio:** migrate EventsPanel, GlossaryPanel, RelationshipsPanel to koine-ui via the ReadableStore host-adapter ([#1408](https://github.com/Atypical-Consulting/Koine/issues/1408)) ([#1458](https://github.com/Atypical-Consulting/Koine/issues/1458)) ([431ac92](https://github.com/Atypical-Consulting/Koine/commit/431ac928c3c20575e1fd47251681792894a8159b))
* **studio:** restore per-file DDD-kind tint and line count in the generated tree ([#1361](https://github.com/Atypical-Consulting/Koine/issues/1361)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** scope + global commands in the rebindable keybindings registry ([#432](https://github.com/Atypical-Consulting/Koine/issues/432)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** show workspace-op-gated palette entries as visible-but-disabled ([#1407](https://github.com/Atypical-Consulting/Koine/issues/1407)) ([#1454](https://github.com/Atypical-Consulting/Koine/issues/1454)) ([b5ef514](https://github.com/Atypical-Consulting/Koine/commit/b5ef5140f600232200f79ed36c9073b9638ec137))


### Bug Fixes

* **ci:** disable MSBuild node reuse to stop concurrent-worktree dotnet test deadlocks ([#1552](https://github.com/Atypical-Consulting/Koine/issues/1552)) ([#1559](https://github.com/Atypical-Consulting/Koine/issues/1559)) ([144b2c4](https://github.com/Atypical-Consulting/Koine/commit/144b2c43f9bce916347350d1a14cf8093840f248))
* **ci:** eliminate the phantom skipped build-and-test check-run on draft-gated workflows ([#1530](https://github.com/Atypical-Consulting/Koine/issues/1530)) ([#1546](https://github.com/Atypical-Consulting/Koine/issues/1546)) ([73ed156](https://github.com/Atypical-Consulting/Koine/commit/73ed15687a8f1edc879230580e2c2c14f1ca2bb7))
* **cli:** scope WorkspaceIndex.FindReferences by bounded context ([#1376](https://github.com/Atypical-Consulting/Koine/issues/1376)) ([#1428](https://github.com/Atypical-Consulting/Koine/issues/1428)) ([03f9671](https://github.com/Atypical-Consulting/Koine/commit/03f9671344ad763d29ce0fcdede1898febdcac97))
* **compiler:** declare the ModelNode/ModelMember record API in PublicAPI.Unshipped.txt ([#1474](https://github.com/Atypical-Consulting/Koine/issues/1474)) ([708f0a7](https://github.com/Atypical-Consulting/Koine/commit/708f0a7636043fa93fa94cd0ddab8fdcd254adff))
* **design-sync:** carry the --koi-muted WCAG-AA fix into the design source ([#1424](https://github.com/Atypical-Consulting/Koine/issues/1424)) ([#1441](https://github.com/Atypical-Consulting/Koine/issues/1441)) ([af7c24c](https://github.com/Atypical-Consulting/Koine/commit/af7c24ca844e3cccfcc242797b08c4159fb1f255))
* **emit-core:** restore shadowed outer bindings via a shared LocalScopeStack in the TS/Python/PHP/Java/Kotlin translators ([#1497](https://github.com/Atypical-Consulting/Koine/issues/1497)) ([#1532](https://github.com/Atypical-Consulting/Koine/issues/1532)) ([608f63f](https://github.com/Atypical-Consulting/Koine/commit/608f63fadbace0c848ef4f9efb6809530104d698))
* **emit-java:** alpha-rename a let binding that shadows a live local ([#1536](https://github.com/Atypical-Consulting/Koine/issues/1536)) ([#1554](https://github.com/Atypical-Consulting/Koine/issues/1554)) ([8bdcfbc](https://github.com/Atypical-Consulting/Koine/commit/8bdcfbc6dce151a79e5956e1c3c9fed253699614))
* **emit-java:** numerically coerce a factory's explicit init against the member's declared type ([#1519](https://github.com/Atypical-Consulting/Koine/issues/1519)) ([#1540](https://github.com/Atypical-Consulting/Koine/issues/1540)) ([13de1fe](https://github.com/Atypical-Consulting/Koine/commit/13de1fe0d63f7676328b0b28d7d4194a57493cae))
* **emit-java:** Optional.of-wrap a factory's explicit init of an optional-declared required member ([#1518](https://github.com/Atypical-Consulting/Koine/issues/1518)) ([fb197f8](https://github.com/Atypical-Consulting/Koine/commit/fb197f8e95ceed7db2666b38230e91b6d8273ca8))
* **emit-java:** Optional.of-wrap an auto-bound parameter binding to an optional-declared required member ([#1480](https://github.com/Atypical-Consulting/Koine/issues/1480)) ([#1521](https://github.com/Atypical-Consulting/Koine/issues/1521)) ([175ffb9](https://github.com/Atypical-Consulting/Koine/commit/175ffb9d47b995f03ebd45f05822a79675906365))
* **emit-java:** preserve Optional-shape when a coalesce's fallback is itself optional-typed ([#1520](https://github.com/Atypical-Consulting/Koine/issues/1520)) ([#1545](https://github.com/Atypical-Consulting/Koine/issues/1545)) ([e127444](https://github.com/Atypical-Consulting/Koine/commit/e1274449d23087b9f4b6ba040d4b5a2cb22c929a))
* **emit-php:** compare entity id by value in equals(), not by PHP object reference ([#1377](https://github.com/Atypical-Consulting/Koine/issues/1377)) ([#1427](https://github.com/Atypical-Consulting/Koine/issues/1427)) ([afaca1b](https://github.com/Atypical-Consulting/Koine/commit/afaca1b2d0ada992598c8228b4ecf5bb80b21db9))
* **emit-rust:** close the five remaining optionality/guard emit gaps ([#1510](https://github.com/Atypical-Consulting/Koine/issues/1510)) ([8264f87](https://github.com/Atypical-Consulting/Koine/commit/8264f87276ebe826298197c8b64cfaa270f67cc3))
* **emit-rust:** coerce a factory's explicit init of a required numeric member in BuildFactoryCtorArgs ([#1438](https://github.com/Atypical-Consulting/Koine/issues/1438)) ([#1449](https://github.com/Atypical-Consulting/Koine/issues/1449)) ([5e65d35](https://github.com/Atypical-Consulting/Koine/commit/5e65d35c54b22ba3e3f7fceeb25602eaca82a1f6))
* **emit-rust:** coerce a read-model derived field's numeric type mismatch ([#1378](https://github.com/Atypical-Consulting/Koine/issues/1378)) ([#1494](https://github.com/Atypical-Consulting/Koine/issues/1494)) ([64da45f](https://github.com/Atypical-Consulting/Koine/commit/64da45fc6a2a3402b82390652bede361bae40fa2))
* **emit-rust:** coerce a transition value toward the target field's declared type ([#1511](https://github.com/Atypical-Consulting/Koine/issues/1511)) ([#1516](https://github.com/Atypical-Consulting/Koine/issues/1516)) ([25e6de7](https://github.com/Atypical-Consulting/Koine/commit/25e6de7befc323c1d0b38a827523e926776fecd2))
* **emit-rust:** coerce OwnDerived's optional-body numeric mismatch ([#1495](https://github.com/Atypical-Consulting/Koine/issues/1495)) ([#1509](https://github.com/Atypical-Consulting/Koine/issues/1509)) ([15ccbf4](https://github.com/Atypical-Consulting/Koine/commit/15ccbf49702d28e6e9ff1f68e02d3f5fb5760129))
* **emit-rust:** entity's optional-declared defaulted member gains a ctor parameter and honors factory init ([#1437](https://github.com/Atypical-Consulting/Koine/issues/1437)) ([#1459](https://github.com/Atypical-Consulting/Koine/issues/1459)) ([79c51f3](https://github.com/Atypical-Consulting/Koine/commit/79c51f324a7b9bfd873e9f6b02fb4768629a065b))
* **emit-rust:** give PushLocal/PopLocal shadow-stack semantics ([#1370](https://github.com/Atypical-Consulting/Koine/issues/1370)) ([#1496](https://github.com/Atypical-Consulting/Koine/issues/1496)) ([f2183c5](https://github.com/Atypical-Consulting/Koine/commit/f2183c54ddff844a62444a7b40e76bf2db02e11a))
* **emit-rust:** map-coerce an Option-typed numerically-mismatched derived/default body in WriteDerived ([#1487](https://github.com/Atypical-Consulting/Koine/issues/1487)) ([#1490](https://github.com/Atypical-Consulting/Koine/issues/1490)) ([3c1edd1](https://github.com/Atypical-Consulting/Koine/commit/3c1edd1ee18ee528824f7ef10bb3544fe8356bc9))
* **emit-rust:** map-coerce an Option-typed numerically-mismatched factory-init value in BuildFactoryCtorArgs ([#1468](https://github.com/Atypical-Consulting/Koine/issues/1468)) ([#1484](https://github.com/Atypical-Consulting/Koine/issues/1484)) ([373f9c2](https://github.com/Atypical-Consulting/Koine/commit/373f9c207f7cd4dce9e2070e2be465c61f317fc4))
* **emit-rust:** map-render WriteUnary's Neg/Not when the operand is itself optional ([#1372](https://github.com/Atypical-Consulting/Koine/issues/1372)) ([#1499](https://github.com/Atypical-Consulting/Koine/issues/1499)) ([ef18497](https://github.com/Atypical-Consulting/Koine/commit/ef18497f15fd17736f130986f82433454e4b24d7))
* **emit-rust:** narrow a presence-guarded optional member in a command's invariant re-check ([#1489](https://github.com/Atypical-Consulting/Koine/issues/1489)) ([#1502](https://github.com/Atypical-Consulting/Koine/issues/1502)) ([e1bacd4](https://github.com/Atypical-Consulting/Koine/commit/e1bacd433277814482399294b02341ff839020ac))
* **emit-rust:** own a smart-enum String associated-data read instead of cloning a borrowed &str ([#1533](https://github.com/Atypical-Consulting/Koine/issues/1533)) ([#1555](https://github.com/Atypical-Consulting/Koine/issues/1555)) ([459fa80](https://github.com/Atypical-Consulting/Koine/commit/459fa80cd67e43b1c823881f7d6998f9caa100e9))
* **emit-rust:** render a non-optional defaulted member as a trailing Option&lt;T&gt; constructor parameter ([#1380](https://github.com/Atypical-Consulting/Koine/issues/1380)) ([#1429](https://github.com/Atypical-Consulting/Koine/issues/1429)) ([3f5568b](https://github.com/Atypical-Consulting/Koine/commit/3f5568b1b2fa50a9f9c8b8913a7124939f69675e))
* **emit-rust:** return optional smart-enum accessors by value instead of by reference ([#1508](https://github.com/Atypical-Consulting/Koine/issues/1508)) ([8264f87](https://github.com/Atypical-Consulting/Koine/commit/8264f87276ebe826298197c8b64cfaa270f67cc3))
* **emit-rust:** return optional-but-Copy-inner accessors by value ([#1373](https://github.com/Atypical-Consulting/Koine/issues/1373)) ([#1507](https://github.com/Atypical-Consulting/Koine/issues/1507)) ([129ec2f](https://github.com/Atypical-Consulting/Koine/commit/129ec2f0f6f2f04aef124d6301941cbdfff69bf3))
* **emit-rust:** run invariant guards before re-wrapping a defaulted optional member ([#1472](https://github.com/Atypical-Consulting/Koine/issues/1472)) ([#1488](https://github.com/Atypical-Consulting/Koine/issues/1488)) ([30033ce](https://github.com/Atypical-Consulting/Koine/commit/30033ceb03a3f0c5551272b65cdcf8770eefb499))
* **emit-rust:** Some-wrap a factory's explicit init of an optional-declared required member ([#1452](https://github.com/Atypical-Consulting/Koine/issues/1452)) ([#1464](https://github.com/Atypical-Consulting/Koine/issues/1464)) ([1a51f15](https://github.com/Atypical-Consulting/Koine/commit/1a51f15dcdefc480a4a3c9a0421d3dc47eac8235))
* **emit-rust:** Some-wrap an auto-bound non-optional parameter binding to an optional-declared required member ([#1467](https://github.com/Atypical-Consulting/Koine/issues/1467)) ([#1476](https://github.com/Atypical-Consulting/Koine/issues/1476)) ([cf7aa06](https://github.com/Atypical-Consulting/Koine/commit/cf7aa066874952fed14e569c0b4c9416b9585b12))
* **emit-rust:** Some(...)-wrap result and emit-payload paths toward their target's declared optionality ([#1523](https://github.com/Atypical-Consulting/Koine/issues/1523)) ([#1539](https://github.com/Atypical-Consulting/Koine/issues/1539)) ([8489d3c](https://github.com/Atypical-Consulting/Koine/commit/8489d3c002c6030d465065418f6ea0a54886ede3))
* **emit-rust:** value object's non-optional-declared defaulted member becomes a trailing Option&lt;T&gt; constructor parameter ([#1436](https://github.com/Atypical-Consulting/Koine/issues/1436)) ([#1455](https://github.com/Atypical-Consulting/Koine/issues/1455)) ([a0684b4](https://github.com/Atypical-Consulting/Koine/commit/a0684b4413f141db7a1f6f7fa3bee538aa0be717))
* **emit-rust:** value object's optional-declared defaulted member gains a ctor parameter ([#1463](https://github.com/Atypical-Consulting/Koine/issues/1463)) ([#1469](https://github.com/Atypical-Consulting/Koine/issues/1469)) ([c0d1db7](https://github.com/Atypical-Consulting/Koine/commit/c0d1db795d5cae60598b4a1cc8ba555923740e27))
* **emit-ts:** map-widen a guard-narrowed optional Decimal operand in Decimal arithmetic ([#1557](https://github.com/Atypical-Consulting/Koine/issues/1557)) ([#1562](https://github.com/Atypical-Consulting/Koine/issues/1562)) ([adcb342](https://github.com/Atypical-Consulting/Koine/commit/adcb342fe77de79c890441294877be3e4200ed82))
* **emit-ts:** widen an Int operand to Decimal in Decimal arithmetic ([#1537](https://github.com/Atypical-Consulting/Koine/issues/1537)) ([#1553](https://github.com/Atypical-Consulting/Koine/issues/1553)) ([5a75e8c](https://github.com/Atypical-Consulting/Koine/commit/5a75e8c3d922a76a671ae670e3322a2722b06516))
* **language:** report a let expression with a missing body instead of crashing ([#1512](https://github.com/Atypical-Consulting/Koine/issues/1512)) ([#1514](https://github.com/Atypical-Consulting/Koine/issues/1514)) ([e583e9c](https://github.com/Atypical-Consulting/Koine/commit/e583e9c75e3b1000bc315365017b9badbea4fdd9))
* **semantics:** suppress redundant outer diagnostics for an already-reported nested mismatch ([#1525](https://github.com/Atypical-Consulting/Koine/issues/1525)) ([#1549](https://github.com/Atypical-Consulting/Koine/issues/1549)) ([8972253](https://github.com/Atypical-Consulting/Koine/commit/8972253374de9346220b7a5bd691564a9262d983))
* **semantics:** validate Neg/Not operand types instead of accepting anything ([#1501](https://github.com/Atypical-Consulting/Koine/issues/1501)) ([#1517](https://github.com/Atypical-Consulting/Koine/issues/1517)) ([aa5924c](https://github.com/Atypical-Consulting/Koine/commit/aa5924cb476f691ef9fdb7728feb13ba5a416008))
* **semantics:** validate unknown member access on Enum receivers and block the Rust EffectiveScope shadow fallthrough ([#1498](https://github.com/Atypical-Consulting/Koine/issues/1498)) ([#1529](https://github.com/Atypical-Consulting/Koine/issues/1529)) ([6170bce](https://github.com/Atypical-Consulting/Koine/commit/6170bce7027f4ed095964a1cd858432e3b7eb653))
* **skills:** flatten paginated comments before selecting the latest plan comment ([#1544](https://github.com/Atypical-Consulting/Koine/issues/1544)) ([#1550](https://github.com/Atypical-Consulting/Koine/issues/1550)) ([bd419cd](https://github.com/Atypical-Consulting/Koine/commit/bd419cd1676ff1b0ab0a712dd39507902f5482b9))
* **skills:** gate merge-pr on failed/pending checks, not on build-and-test success ([#1535](https://github.com/Atypical-Consulting/Koine/issues/1535)) ([#1541](https://github.com/Atypical-Consulting/Koine/issues/1541)) ([7c95069](https://github.com/Atypical-Consulting/Koine/commit/7c95069030a85c5c03f8213caac41e2aa50cfbe4))
* **studio:** adopt mid-edit external committedValue on cancel in useCommittableField ([#1398](https://github.com/Atypical-Consulting/Koine/issues/1398)) ([#1446](https://github.com/Atypical-Consulting/Koine/issues/1446)) ([692ec8c](https://github.com/Atypical-Consulting/Koine/commit/692ec8c7c8d514978c0e6a77d454ffdf1d9d62be))
* **studio:** align the settings gear with the right-rail icons and seat the rail on a 36px grid ([#1426](https://github.com/Atypical-Consulting/Koine/issues/1426)) ([efebb86](https://github.com/Atypical-Consulting/Koine/commit/efebb86349b098aac16c91ba17a2efd95a7a2a1c))
* **studio:** deflake the Source Control header-actions portal test in inspectorController.test.ts ([#1448](https://github.com/Atypical-Consulting/Koine/issues/1448)) ([#1466](https://github.com/Atypical-Consulting/Koine/issues/1466)) ([4caaca4](https://github.com/Atypical-Consulting/Koine/commit/4caaca47c3ba95e83b0628b0fe9a4b2059e181a6))
* **studio:** guard the async recents branch capture against reorder/resurrect ([#1016](https://github.com/Atypical-Consulting/Koine/issues/1016)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** guard the domain-index and model-index caches against a stale-build TOCTOU race ([#1447](https://github.com/Atypical-Consulting/Koine/issues/1447)) ([#1456](https://github.com/Atypical-Consulting/Koine/issues/1456)) ([5e419c3](https://github.com/Atypical-Consulting/Koine/commit/5e419c38160578472d32f754d4740d7b9febf2b7))
* **studio:** lighten --koi-muted to meet WCAG AA contrast on dark card surfaces ([#991](https://github.com/Atypical-Consulting/Koine/issues/991)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** parse git_status porcelain v2 with -z so quoted paths round-trip ([#1400](https://github.com/Atypical-Consulting/Koine/issues/1400)) ([#1430](https://github.com/Atypical-Consulting/Koine/issues/1430)) ([112e81d](https://github.com/Atypical-Consulting/Koine/commit/112e81dcc77758084cf519c7bd2122d2ad78002d))
* **studio:** remove untracked directory rows on Discard via pathspec-scoped git clean -d ([#1399](https://github.com/Atypical-Consulting/Koine/issues/1399)) ([#1461](https://github.com/Atypical-Consulting/Koine/issues/1461)) ([f0f2c25](https://github.com/Atypical-Consulting/Koine/commit/f0f2c25dce04477204e27ad8fcec5d754a6e2e83))
* **studio:** render real glossary text instead of [object Object] in GlossaryPanel ([#1470](https://github.com/Atypical-Consulting/Koine/issues/1470)) ([#1473](https://github.com/Atypical-Consulting/Koine/issues/1473)) ([9a5643b](https://github.com/Atypical-Consulting/Koine/commit/9a5643b7b1638662e87dd9d9ffb0f969c73f466d))
* **studio:** route saveProjectToDisk through the locked openWorkspace facade ([#1404](https://github.com/Atypical-Consulting/Koine/issues/1404)) ([#1460](https://github.com/Atypical-Consulting/Koine/issues/1460)) ([913beea](https://github.com/Atypical-Consulting/Koine/commit/913beeaf5408f363cf941a5603b840ac4a6e483c))
* **studio:** seat the collapsed left navigator spine on the right rail's 36px grid ([#1435](https://github.com/Atypical-Consulting/Koine/issues/1435)) ([89250b6](https://github.com/Atypical-Consulting/Koine/commit/89250b686008bf8a011800737fc2dfc94b3439be))
* **studio:** show an untracked directory row's folder name instead of a blank primary label ([#1462](https://github.com/Atypical-Consulting/Koine/issues/1462)) ([#1465](https://github.com/Atypical-Consulting/Koine/issues/1465)) ([e69a903](https://github.com/Atypical-Consulting/Koine/commit/e69a903689131bca985e874f304be3a569a5469a))
* **studio:** strip literal NUL bytes from modelTables.ts ([#1384](https://github.com/Atypical-Consulting/Koine/issues/1384)) ([#1524](https://github.com/Atypical-Consulting/Koine/issues/1524)) ([071fbdf](https://github.com/Atypical-Consulting/Koine/commit/071fbdf0621cc111f6b0592689cb5046dfe8c37d))
* **studio:** use lang-json in the JSON view and quiet expected error-path test logs ([#1475](https://github.com/Atypical-Consulting/Koine/issues/1475)) ([af0b57f](https://github.com/Atypical-Consulting/Koine/commit/af0b57f60cbcb6003650c63e3930e00a37f361e9))
* **website:** adapt blog/rss.xml.ts to starlight-blog 0.28's prefix-required RSS handler ([#1431](https://github.com/Atypical-Consulting/Koine/issues/1431)) ([#1434](https://github.com/Atypical-Consulting/Koine/issues/1434)) ([363b64e](https://github.com/Atypical-Consulting/Koine/commit/363b64e20b8da7084eba52b8910415d59c4a8122))


### Performance Improvements

* **emit-core:** infer each ConditionalExpr branch's type once in Java/Kotlin/TypeScript/Python ([#1369](https://github.com/Atypical-Consulting/Koine/issues/1369)) ([#1482](https://github.com/Atypical-Consulting/Koine/issues/1482)) ([8eca379](https://github.com/Atypical-Consulting/Koine/commit/8eca379592bab06d3b8d01178f7e43a4272eb0d1))
* **studio:** bulk buffer-set → O(N) workspace open/teardown ([#1012](https://github.com/Atypical-Consulting/Koine/issues/1012)) ([a6b087f](https://github.com/Atypical-Consulting/Koine/commit/a6b087f555b4e405bb645937f2f790a25d77e95e))
* **studio:** seed the Domain navigator's first-mount fetch ([#1397](https://github.com/Atypical-Consulting/Koine/issues/1397)) ([#1450](https://github.com/Atypical-Consulting/Koine/issues/1450)) ([c31f4c2](https://github.com/Atypical-Consulting/Koine/commit/c31f4c2506dd9959c01e212f61efe86158964d38))
* **studio:** share the in-flight glossaryModel fetch with buildDomainIndex ([#1405](https://github.com/Atypical-Consulting/Koine/issues/1405)) ([#1444](https://github.com/Atypical-Consulting/Koine/issues/1444)) ([7b4efb0](https://github.com/Atypical-Consulting/Koine/commit/7b4efb0a7f1f2d3fd781a92d55396ca1c9d349ba))
* **studio:** unmount the StoreInspector overlay when hidden ([#1395](https://github.com/Atypical-Consulting/Koine/issues/1395)) ([#1445](https://github.com/Atypical-Consulting/Koine/issues/1445)) ([f7fbd02](https://github.com/Atypical-Consulting/Koine/commit/f7fbd027dfd32d5b263fb97e4c71d46b504fc6ba))

## [0.250.0](https://github.com/Atypical-Consulting/Koine/compare/v0.249.0...v0.250.0) (2026-07-11)


### Features

* **studio:** add a Source Control ahead/behind sync readout and push action ([#1150](https://github.com/Atypical-Consulting/Koine/issues/1150)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** add Source Control Discard all and per-row Discard behind a confirm gate ([#1151](https://github.com/Atypical-Consulting/Koine/issues/1151)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** clear the studio-shell backlog — 16 grouped shell fixes ([#1387](https://github.com/Atypical-Consulting/Koine/issues/1387)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** migrate UnsavedIndicator, DiagnosticsStripPanel, and DocsPanelHost to koine-ui ([#1244](https://github.com/Atypical-Consulting/Koine/issues/1244)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))


### Bug Fixes

* **deps:** update dependency @anthropic-ai/sdk to ^0.111.0 ([#1393](https://github.com/Atypical-Consulting/Koine/issues/1393)) ([5f753f1](https://github.com/Atypical-Consulting/Koine/commit/5f753f1d589ec0172488318440720180aedf031f))
* **deps:** update dependency starlight-blog to ^0.28.0 ([#1391](https://github.com/Atypical-Consulting/Koine/issues/1391)) ([b703349](https://github.com/Atypical-Consulting/Koine/commit/b7033494f34a6a9058c7f6a2fe91bf97656cb2e5))
* **studio:** address branch-wide code-review findings, incl. per-row Discard destroying staged-row edits and git_discard no-op on C-quoted filenames ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** key SortableTable rows on rowLabel to avoid remount-on-sort churn ([#1382](https://github.com/Atypical-Consulting/Koine/issues/1382)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** make the workspace-open lock impossible to bypass and disable controls in flight ([#1275](https://github.com/Atypical-Consulting/Koine/issues/1275)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** move Source Control header actions into the shared right-rail header and align panel insets ([#1410](https://github.com/Atypical-Consulting/Koine/issues/1410)) ([bafbdb2](https://github.com/Atypical-Consulting/Koine/commit/bafbdb2ec4b3e6fa1ac0b6277b32c533e6216049))
* **studio:** revert-and-close the ADR/Note edit textareas on Escape ([#1383](https://github.com/Atypical-Consulting/Koine/issues/1383)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** scope the Problems tab count pill to the active context ([#1203](https://github.com/Atypical-Consulting/Koine/issues/1203)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** shrink .koi-resizer/.koi-resizer-y handles to 1px ([#1388](https://github.com/Atypical-Consulting/Koine/issues/1388)) ([aa7c64c](https://github.com/Atypical-Consulting/Koine/commit/aa7c64c1d8135e45275beabd3bfac3fa1bf7f39d))


### Performance Improvements

* **studio:** make the StoreInspector raw dump lazy and throttled ([#1134](https://github.com/Atypical-Consulting/Koine/issues/1134)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))
* **studio:** route refreshContextList() through the shared glossary memoizer ([#1258](https://github.com/Atypical-Consulting/Koine/issues/1258)) ([92fbf20](https://github.com/Atypical-Consulting/Koine/commit/92fbf203e68d1a4149c2fc2f4d4b885ff79421c7))

## [0.249.0](https://github.com/Atypical-Consulting/Koine/compare/v0.248.0...v0.249.0) (2026-07-10)


### Features

* **demo:** runnable demos for the TypeScript/Python/PHP/Rust targets ([#1073](https://github.com/Atypical-Consulting/Koine/issues/1073)) ([#1360](https://github.com/Atypical-Consulting/Koine/issues/1360)) ([5443116](https://github.com/Atypical-Consulting/Koine/commit/544311651eec961d190c4a00d198fa7e18dac204))
* **studio:** browse generated output file-by-file via a file tree ([#871](https://github.com/Atypical-Consulting/Koine/issues/871)) ([#1339](https://github.com/Atypical-Consulting/Koine/issues/1339)) ([990a276](https://github.com/Atypical-Consulting/Koine/commit/990a2765bbbd7dfc4c1163b9ae500a79af47472f))
* **studio:** Context Map + Problems obey the active-context scope ([#1188](https://github.com/Atypical-Consulting/Koine/issues/1188)) ([#1200](https://github.com/Atypical-Consulting/Koine/issues/1200)) ([f44eb77](https://github.com/Atypical-Consulting/Koine/commit/f44eb77fa1fc170405402ebbfff9a05b6f4729ee))
* **studio:** eager +n/−n line counts on Source Control rows via git numstat ([#1152](https://github.com/Atypical-Consulting/Koine/issues/1152)) ([#1194](https://github.com/Atypical-Consulting/Koine/issues/1194)) ([ad4e62d](https://github.com/Atypical-Consulting/Koine/commit/ad4e62dce52419065d6b9deca1dde3c1d1b11339))
* **studio:** make the status-bar Context segment a clickable scope picker ([#1182](https://github.com/Atypical-Consulting/Koine/issues/1182)) ([e92e8bf](https://github.com/Atypical-Consulting/Koine/commit/e92e8bf33203d91abb20ee5e00961278e4814772))
* **studio:** prototype a host-adapter seam for store-coupled UI panels ([#944](https://github.com/Atypical-Consulting/Koine/issues/944)) ([#1235](https://github.com/Atypical-Consulting/Koine/issues/1235)) ([c2b8252](https://github.com/Atypical-Consulting/Koine/commit/c2b82522c24340449883a48ee8975afdbb054c8f))
* **studio:** surface real state-machine transitions in the ⌘K launcher ([#1163](https://github.com/Atypical-Consulting/Koine/issues/1163)) ([#1195](https://github.com/Atypical-Consulting/Koine/issues/1195)) ([7ea254d](https://github.com/Atypical-Consulting/Koine/commit/7ea254da9925e5f1390b4eea8d4dfd92856376ca))
* **studio:** the left rail obeys the active-context scope ([#1188](https://github.com/Atypical-Consulting/Koine/issues/1188)) ([#1198](https://github.com/Atypical-Consulting/Koine/issues/1198)) ([f96b432](https://github.com/Atypical-Consulting/Koine/commit/f96b43299c09235258fcd4d9c558ccccc29b8d94))
* **studio:** the Output rail obeys the active-context scope (ADR 0009) ([#1196](https://github.com/Atypical-Consulting/Koine/issues/1196)) ([2553d3a](https://github.com/Atypical-Consulting/Koine/commit/2553d3a39d906cc5024ba90723268a3b14f9cdf9))
* **studio:** wire the launcher's degraded quick actions to real seams ([#1165](https://github.com/Atypical-Consulting/Koine/issues/1165)) ([#1192](https://github.com/Atypical-Consulting/Koine/issues/1192)) ([2e8af3e](https://github.com/Atypical-Consulting/Koine/commit/2e8af3e02e6bf89b644c9a4b2e109d517c85a89f))
* **tooling:** harden aggregate-root Id co-rename with context scoping and an authoritative status signal ([#565](https://github.com/Atypical-Consulting/Koine/issues/565)) ([#1346](https://github.com/Atypical-Consulting/Koine/issues/1346)) ([99aa42c](https://github.com/Atypical-Consulting/Koine/commit/99aa42c8d108ce3fe15066338ac874999d2f1e86))


### Bug Fixes

* **deps:** update dependency @maxgraph/core to ^0.24.0 ([#1205](https://github.com/Atypical-Consulting/Koine/issues/1205)) ([52a4811](https://github.com/Atypical-Consulting/Koine/commit/52a4811a82f28f6e8ff62e2a542807b2184223a8))
* **emit-core:** reconcile disagreeing ConditionalExpr branches across Java/TS/Kotlin/Python ([#1344](https://github.com/Atypical-Consulting/Koine/issues/1344)) ([#1348](https://github.com/Atypical-Consulting/Koine/issues/1348)) ([f766414](https://github.com/Atypical-Consulting/Koine/commit/f76641437d8269c8ff577db909c5d9c804f7b863))
* **emit-core:** resolve ScalarOpWalker operands by full type instead of shallow identifier match ([#1289](https://github.com/Atypical-Consulting/Koine/issues/1289)) ([#1296](https://github.com/Atypical-Consulting/Koine/issues/1296)) ([f8c4189](https://github.com/Atypical-Consulting/Koine/commit/f8c4189f3be87702a397d006f3dc1dec9b9cc091))
* **emit-php:** gate multipliedBy/dividedBy independently off MultiplyFactors/DivideFactors ([#1301](https://github.com/Atypical-Consulting/Koine/issues/1301)) ([#1302](https://github.com/Atypical-Consulting/Koine/issues/1302)) ([6077075](https://github.com/Atypical-Consulting/Koine/commit/6077075f1c6bf33e75817422a0bf3eafff434e87))
* **emit-rust:** borrow compound operands in quantity +/- unit-checked routing ([#1268](https://github.com/Atypical-Consulting/Koine/issues/1268)) ([#1278](https://github.com/Atypical-Consulting/Koine/issues/1278)) ([7ab1590](https://github.com/Atypical-Consulting/Koine/commit/7ab1590e6a811eeab231d75877e64c01e4b0b70a))
* **emit-rust:** clone non-Copy conditional/let/coalesce branches outside the quantity guard ([#1282](https://github.com/Atypical-Consulting/Koine/issues/1282)) ([#1287](https://github.com/Atypical-Consulting/Koine/issues/1287)) ([41d4d95](https://github.com/Atypical-Consulting/Koine/commit/41d4d951d609a7a690e967f81fe70d6a896ed146))
* **emit-rust:** coerce a value object's constant-default field to its declared Rust type in new ([#1319](https://github.com/Atypical-Consulting/Koine/issues/1319)) ([#1323](https://github.com/Atypical-Consulting/Koine/issues/1323)) ([38197c4](https://github.com/Atypical-Consulting/Koine/commit/38197c443c2e944c4db75c72fba3d870e12911ce))
* **emit-rust:** coerce a whole mismatched-type conditional operand once ([#1293](https://github.com/Atypical-Consulting/Koine/issues/1293)) ([#1307](https://github.com/Atypical-Consulting/Koine/issues/1307)) ([b24f777](https://github.com/Atypical-Consulting/Koine/commit/b24f777675c1c35a601819e5a74872c14fc083e5))
* **emit-rust:** coerce an entity's constant-default field to its declared Rust type in new ([#1324](https://github.com/Atypical-Consulting/Koine/issues/1324)) ([#1327](https://github.com/Atypical-Consulting/Koine/issues/1327)) ([3451181](https://github.com/Atypical-Consulting/Koine/commit/34511815b76a7a779100590aaa8bd5e5df93c08e))
* **emit-rust:** coerce and Some(...)-wrap an optional derived member's bare non-optional body ([#1329](https://github.com/Atypical-Consulting/Koine/issues/1329)) ([#1330](https://github.com/Atypical-Consulting/Koine/issues/1330)) ([4ddf2fe](https://github.com/Atypical-Consulting/Koine/commit/4ddf2fe4cb965840abcaec1dfc15e83bbc9c6de4))
* **emit-rust:** emit scalar Mul/Div impls for quantities ([#1084](https://github.com/Atypical-Consulting/Koine/issues/1084)) ([#1265](https://github.com/Atypical-Consulting/Koine/issues/1265)) ([4fb0ec6](https://github.com/Atypical-Consulting/Koine/commit/4fb0ec64d6383a249577a4d969cdc2394df3a61f))
* **emit-rust:** extend coerceTo dispatch to comparisons, disagreeing branches, and bare operands ([#1311](https://github.com/Atypical-Consulting/Koine/issues/1311)) ([#1315](https://github.com/Atypical-Consulting/Koine/issues/1315)) ([5166c49](https://github.com/Atypical-Consulting/Koine/commit/5166c49cdc97a796651b55b016bdff61abe5755a))
* **emit-rust:** extend the whole-operand coercion wrap to a bare UnaryExpr operand ([#1326](https://github.com/Atypical-Consulting/Koine/issues/1326)) ([3fd278c](https://github.com/Atypical-Consulting/Koine/commit/3fd278c7d3fb1e3fb79545c6cc023ca8e1144592))
* **emit-rust:** extend the whole-operand coercion wrap to bare MemberAccessExpr/CallExpr operands ([#1316](https://github.com/Atypical-Consulting/Koine/issues/1316)) ([#1320](https://github.com/Atypical-Consulting/Koine/issues/1320)) ([6f27528](https://github.com/Atypical-Consulting/Koine/commit/6f2752867001a94700d3f114767337513ba12f6d))
* **emit-rust:** map-render an optional MemberAccessExpr/CallExpr/UnaryExpr operand coerced toward Decimal instead of wrap-prefixing it ([#1354](https://github.com/Atypical-Consulting/Koine/issues/1354)) ([#1357](https://github.com/Atypical-Consulting/Koine/issues/1357)) ([1b7b4db](https://github.com/Atypical-Consulting/Koine/commit/1b7b4db727b83af9341d9f75195ac91447263a8c))
* **emit-rust:** map-render an optional-Int conditional-branch numeric widen instead of wrap-prefixing it ([#1335](https://github.com/Atypical-Consulting/Koine/issues/1335)) ([#1338](https://github.com/Atypical-Consulting/Koine/issues/1338)) ([de182dd](https://github.com/Atypical-Consulting/Koine/commit/de182ddbebdd07dda9e1dc307344816d0dfe724f))
* **emit-rust:** map-render an optional-Int operand coerced toward Decimal in comparisons ([#1343](https://github.com/Atypical-Consulting/Koine/issues/1343)) ([#1347](https://github.com/Atypical-Consulting/Koine/issues/1347)) ([2dfa86d](https://github.com/Atypical-Consulting/Koine/commit/2dfa86dace0e10df7a294ede67a9d2b10c31631e))
* **emit-rust:** own a .trim() result for an optional-declared String derived member ([#1332](https://github.com/Atypical-Consulting/Koine/issues/1332)) ([#1337](https://github.com/Atypical-Consulting/Koine/issues/1337)) ([908cdfe](https://github.com/Atypical-Consulting/Koine/commit/908cdfe4434ba3c4b0a6cc65c9784f171f4a8161))
* **emit-rust:** own and Some(...)-wrap an optional-declared read-model derived String field ([#1349](https://github.com/Atypical-Consulting/Koine/issues/1349)) ([#1358](https://github.com/Atypical-Consulting/Koine/issues/1358)) ([05233e6](https://github.com/Atypical-Consulting/Koine/commit/05233e6adb24a2ae4bba36da41852071cc7e8c10))
* **emit-rust:** render .or_else(...) for a CoalesceExpr with an optional right operand ([#1333](https://github.com/Atypical-Consulting/Koine/issues/1333)) ([#1336](https://github.com/Atypical-Consulting/Koine/issues/1336)) ([59e0502](https://github.com/Atypical-Consulting/Koine/commit/59e05027789d0825cce2d395495f8025edc00a18))
* **emit-rust:** resolve WriteIdentifier's own optionality internally instead of via ownType ([#1355](https://github.com/Atypical-Consulting/Koine/issues/1355)) ([#1367](https://github.com/Atypical-Consulting/Koine/issues/1367)) ([eaf580c](https://github.com/Atypical-Consulting/Koine/commit/eaf580c6c4121c3b306e585b7ea57250f85a4ccc))
* **emit-rust:** route demand-driven VO arithmetic through the validating constructor ([#1270](https://github.com/Atypical-Consulting/Koine/issues/1270)) ([#1317](https://github.com/Atypical-Consulting/Koine/issues/1317)) ([0726e24](https://github.com/Atypical-Consulting/Koine/commit/0726e2416dc430d8c321e79da5a46a8b790e18de))
* **emit-rust:** route quantity add/sub/scale through the validating constructor ([#1318](https://github.com/Atypical-Consulting/Koine/issues/1318)) ([#1322](https://github.com/Atypical-Consulting/Koine/issues/1322)) ([cb89ac8](https://github.com/Atypical-Consulting/Koine/commit/cb89ac8f8fedefeb1a02064cc222847cd60921a8))
* **emit-rust:** Some(...)-wrap a coerced optional constant-default field in new ([#1325](https://github.com/Atypical-Consulting/Koine/issues/1325)) ([#1328](https://github.com/Atypical-Consulting/Koine/issues/1328)) ([ff725b4](https://github.com/Atypical-Consulting/Koine/commit/ff725b47003deafbb63e8ce72d0491f2298e71a8))
* **emit-rust:** Some(...)-wrap a non-optional conditional branch to match its optional sibling ([#1331](https://github.com/Atypical-Consulting/Koine/issues/1331)) ([#1334](https://github.com/Atypical-Consulting/Koine/issues/1334)) ([dda1796](https://github.com/Atypical-Consulting/Koine/commit/dda1796b04789405ee5a3bc58ec2f9f9211e0db1))
* **emit-ts:** emit a quantity's scalar divide method ([#1269](https://github.com/Atypical-Consulting/Koine/issues/1269)) ([#1273](https://github.com/Atypical-Consulting/Koine/issues/1273)) ([8c102f7](https://github.com/Atypical-Consulting/Koine/commit/8c102f709475cc91d7a8ba90b80dbc1f4e702950))
* **language:** report a diagnostic instead of crashing on an aggregate missing its root clause ([#1298](https://github.com/Atypical-Consulting/Koine/issues/1298)) ([#1303](https://github.com/Atypical-Consulting/Koine/issues/1303)) ([151bf93](https://github.com/Atypical-Consulting/Koine/commit/151bf93abf2bc79a14f24f466458173f51b43d33))
* **semantics:** reject binary */÷ between two value-like operands ([#1291](https://github.com/Atypical-Consulting/Koine/issues/1291)) ([#1306](https://github.com/Atypical-Consulting/Koine/issues/1306)) ([81f7483](https://github.com/Atypical-Consulting/Koine/commit/81f7483d6b718e8d95b7cf6d5e1534894b0db500))
* **semantics:** reject binary */÷ with an entity-typed operand ([#1300](https://github.com/Atypical-Consulting/Koine/issues/1300)) ([#1310](https://github.com/Atypical-Consulting/Koine/issues/1310)) ([0c94f97](https://github.com/Atypical-Consulting/Koine/commit/0c94f97d682be6ba6dd4f67ce1221a91cf2ba7fc))
* **semantics:** reject binary +/- between different quantity types ([#1266](https://github.com/Atypical-Consulting/Koine/issues/1266)) ([#1281](https://github.com/Atypical-Consulting/Koine/issues/1281)) ([80449af](https://github.com/Atypical-Consulting/Koine/commit/80449af51037d45873e8c8e3311fcd76f793efee))
* **semantics:** reject binary +/- between differently-typed value objects ([#1284](https://github.com/Atypical-Consulting/Koine/issues/1284)) ([#1288](https://github.com/Atypical-Consulting/Koine/issues/1288)) ([0ba83a0](https://github.com/Atypical-Consulting/Koine/commit/0ba83a0dc5fcbd7624d2a271cedaa02b41d63c9b))
* **semantics:** reject binary +/- with an entity-typed operand ([#1290](https://github.com/Atypical-Consulting/Koine/issues/1290)) ([#1297](https://github.com/Atypical-Consulting/Koine/issues/1297)) ([62b7cb0](https://github.com/Atypical-Consulting/Koine/commit/62b7cb03303bc0d3fe24c794c70df683798749d8))
* **semantics:** resolve HasNumericStoredField's declaration context-aware ([#1285](https://github.com/Atypical-Consulting/Koine/issues/1285)) ([#1295](https://github.com/Atypical-Consulting/Koine/issues/1295)) ([ad82277](https://github.com/Atypical-Consulting/Koine/commit/ad822777eb47660a7f55249cb52a82aeaf83c7a5))
* **studio:** close the residual races left by the workspace-open guard ([#1088](https://github.com/Atypical-Consulting/Koine/issues/1088)) ([#1271](https://github.com/Atypical-Consulting/Koine/issues/1271)) ([6a624ac](https://github.com/Atypical-Consulting/Koine/commit/6a624ac73c2219e335261c50f3cc9f451776ea59))
* **studio:** draw the domain-canvas selection ring inset instead of clipped outer box-shadow ([#1294](https://github.com/Atypical-Consulting/Koine/issues/1294)) ([#1309](https://github.com/Atypical-Consulting/Koine/issues/1309)) ([5625b86](https://github.com/Atypical-Consulting/Koine/commit/5625b86d2b55252ff4e15d29f8c0c97677006c58))
* **studio:** eliminate jsonSettingsEditor hover test flake under the full suite ([#1233](https://github.com/Atypical-Consulting/Koine/issues/1233)) ([#1247](https://github.com/Atypical-Consulting/Koine/issues/1247)) ([67f26a8](https://github.com/Atypical-Consulting/Koine/commit/67f26a8a8f7cfb5b9f22d49152f7fab508d874e1))
* **studio:** flip HierarchicalLayout orientation so context-map/event-flow read left-to-right ([#1209](https://github.com/Atypical-Consulting/Koine/issues/1209)) ([#1283](https://github.com/Atypical-Consulting/Koine/issues/1283)) ([d188cff](https://github.com/Atypical-Consulting/Koine/commit/d188cff26b95ee2bbe1661f7325cddd8464e5b2b))
* **studio:** guard contextMapPanel's post-await tail on !disposed ([#1261](https://github.com/Atypical-Consulting/Koine/issues/1261)) ([#1305](https://github.com/Atypical-Consulting/Koine/issues/1305)) ([b414481](https://github.com/Atypical-Consulting/Koine/commit/b414481abc87ac00036878199a77fa8c87359ae3))
* **studio:** guard domainNavigator's doFetch() post-await tail on unmount ([#1308](https://github.com/Atypical-Consulting/Koine/issues/1308)) ([#1314](https://github.com/Atypical-Consulting/Koine/issues/1314)) ([1f7fc73](https://github.com/Atypical-Consulting/Koine/commit/1f7fc731dd54e11937da8f4829bda4db2b77092c))
* **studio:** keep assistant tool cards stable across turn commit and failed-send rollback ([#1133](https://github.com/Atypical-Consulting/Koine/issues/1133)) ([#1280](https://github.com/Atypical-Consulting/Koine/issues/1280)) ([c3298cb](https://github.com/Atypical-Consulting/Koine/commit/c3298cba95ab7de7d2e0aa47ae9003e71cee5d92))
* **studio:** keep the launcher catalog alive when git log fails ([#1277](https://github.com/Atypical-Consulting/Koine/issues/1277)) ([5a5719a](https://github.com/Atypical-Consulting/Koine/commit/5a5719a06f95559657fbad70f72511e547d7b1e7))
* **studio:** make centerDeckController's construction-time reset atomic ([#1260](https://github.com/Atypical-Consulting/Koine/issues/1260)) ([#1272](https://github.com/Atypical-Consulting/Koine/issues/1272)) ([35b4cb0](https://github.com/Atypical-Consulting/Koine/commit/35b4cb0cebf279a49c2746d3ba480bc9b489a98f))
* **studio:** make the context-map active-context focus ring paint and survive zoom ([#1210](https://github.com/Atypical-Consulting/Koine/issues/1210)) ([#1292](https://github.com/Atypical-Consulting/Koine/issues/1292)) ([d6f23e4](https://github.com/Atypical-Consulting/Koine/commit/d6f23e472df75851698fd5e1e09119cec76c0cdc))
* **studio:** mark applyFileEdit's non-active-buffer safety-net sync dirty on an unconfirmed write ([#1089](https://github.com/Atypical-Consulting/Koine/issues/1089)) ([#1264](https://github.com/Atypical-Consulting/Koine/issues/1264)) ([edf3598](https://github.com/Atypical-Consulting/Koine/commit/edf3598a723af7e6417b648bb71fbe54aa8782fb))
* **studio:** raise launcher fuzzy-match highlight to WCAG-AA contrast ([#1161](https://github.com/Atypical-Consulting/Koine/issues/1161)) ([#1263](https://github.com/Atypical-Consulting/Koine/issues/1263)) ([d4c55de](https://github.com/Atypical-Consulting/Koine/commit/d4c55dedba14a2812bfe23d235eb039b62907b78))
* **studio:** route saveProjectToDisk's workspace reopen through the shared open-lock ([#1279](https://github.com/Atypical-Consulting/Koine/issues/1279)) ([26578ee](https://github.com/Atypical-Consulting/Koine/commit/26578eef8c82a698ddb27b2f02d7e1934320f715))
* **studio:** source beginChangeSetApply's cleanCount from the host, not sticky drift state ([#1225](https://github.com/Atypical-Consulting/Koine/issues/1225)) ([#1229](https://github.com/Atypical-Consulting/Koine/issues/1229)) ([d523dce](https://github.com/Atypical-Consulting/Koine/commit/d523dce3205a21a27a15c9d41337dd443d3d4552))
* **studio:** wire the context-map hover tooltip onto TooltipHandler and theme it ([#1211](https://github.com/Atypical-Consulting/Koine/issues/1211)) ([#1299](https://github.com/Atypical-Consulting/Koine/issues/1299)) ([666a0e7](https://github.com/Atypical-Consulting/Koine/commit/666a0e7837c41de08a7024b9a0024aa8af507d40))


### Performance Improvements

* **emit-rust:** hoist redundant Then/Else type inference out of WriteReconciledBranch ([#1345](https://github.com/Atypical-Consulting/Koine/issues/1345)) ([#1359](https://github.com/Atypical-Consulting/Koine/issues/1359)) ([aa1c2ad](https://github.com/Atypical-Consulting/Koine/commit/aa1c2adb15609cc513b6ac408e5e57f4a18cb8fb))

## [0.248.0](https://github.com/Atypical-Consulting/Koine/compare/v0.247.0...v0.248.0) (2026-07-07)


### Features

* **emit-cs:** finish W1 handler options — --app-not-found result & --app-handler-result readModel ([#1041](https://github.com/Atypical-Consulting/Koine/issues/1041)) ([#1139](https://github.com/Atypical-Consulting/Koine/issues/1139)) ([f249b14](https://github.com/Atypical-Consulting/Koine/commit/f249b14838ad9e7234d17b129d34311d7f4222d6))
* **emit:** populate DDD kind metadata in the TS/Python/PHP emitters ([#1170](https://github.com/Atypical-Consulting/Koine/issues/1170)) ([#1172](https://github.com/Atypical-Consulting/Koine/issues/1172)) ([5a31a7a](https://github.com/Atypical-Consulting/Koine/commit/5a31a7abdb0f7ec4d5addec72ef6ad40671776f8))
* **studio:** add ⌘K Spotlight command launcher, retire command palette ([#1143](https://github.com/Atypical-Consulting/Koine/issues/1143)) ([#1145](https://github.com/Atypical-Consulting/Koine/issues/1145)) ([0cd1534](https://github.com/Atypical-Consulting/Koine/commit/0cd1534cf1440ca000666c9aba84e7e2891e28c8))
* **studio:** add rstrip hairline separator and widen the tool-window spine to 42px ([#1154](https://github.com/Atypical-Consulting/Koine/issues/1154)) ([#1166](https://github.com/Atypical-Consulting/Koine/issues/1166)) ([2c66a47](https://github.com/Atypical-Consulting/Koine/commit/2c66a47575fe71e4a7af94c59376181e02cd0b4d))
* **studio:** adopt the hexagon-κ logo across app, README, and website ([#1141](https://github.com/Atypical-Consulting/Koine/issues/1141)) ([#1144](https://github.com/Atypical-Consulting/Koine/issues/1144)) ([92119a1](https://github.com/Atypical-Consulting/Koine/commit/92119a11f9e10f4e8bb62ebac5b4fc953341376f))
* **studio:** flush center — one spine, flush focus, per-file output rail ([#1169](https://github.com/Atypical-Consulting/Koine/issues/1169)) ([e21736b](https://github.com/Atypical-Consulting/Koine/commit/e21736b533b2839cd399aeda528d9a8347aa335a))
* **studio:** rebuild the Source Control panel to the handoff design ([#1142](https://github.com/Atypical-Consulting/Koine/issues/1142)) ([#1146](https://github.com/Atypical-Consulting/Koine/issues/1146)) ([61ae0b8](https://github.com/Atypical-Consulting/Koine/commit/61ae0b885e7137b0a3ae833e8659861a466ec969))
* **studio:** wire the Source Control panel's overflow, caret, and history affordances ([#1153](https://github.com/Atypical-Consulting/Koine/issues/1153)) ([#1173](https://github.com/Atypical-Consulting/Koine/issues/1173)) ([4265353](https://github.com/Atypical-Consulting/Koine/commit/4265353e11d3d6c059322ea42cb3dbbb4e4f7f45))


### Bug Fixes

* **studio:** drop the koi-space-4 rail inset from the non-Properties right panels ([#1155](https://github.com/Atypical-Consulting/Koine/issues/1155)) ([9075677](https://github.com/Atypical-Consulting/Koine/commit/90756774ad61f62439e69b57b7a2f8d56e90729d))
* **studio:** make the Output preview pane scroll again ([#1177](https://github.com/Atypical-Consulting/Koine/issues/1177)) ([81cf976](https://github.com/Atypical-Consulting/Koine/commit/81cf97637d9c20be7cb09e382b74a1a6ff9948b0))
* **studio:** open the domain diagram at its default zoom, keep the % readout truthful ([#1159](https://github.com/Atypical-Consulting/Koine/issues/1159)) ([30fe0f2](https://github.com/Atypical-Consulting/Koine/commit/30fe0f2c76e3480ce3ea8651183010e851908180))
* **studio:** stop the toolbar accent bleeding into the emit menu and mark the selected target ([#1157](https://github.com/Atypical-Consulting/Koine/issues/1157)) ([33c60d4](https://github.com/Atypical-Consulting/Koine/commit/33c60d4a96e9c11be96999a99fd2c81f3d1e23f0))
* **tooling:** guard run-ide.ps1 against missing package-lock.json ([#1168](https://github.com/Atypical-Consulting/Koine/issues/1168)) ([2c65ddb](https://github.com/Atypical-Consulting/Koine/commit/2c65ddbf2e7e21226eda228f526dcb39af8ca479))

## [0.247.0](https://github.com/Atypical-Consulting/Koine/compare/v0.246.0...v0.247.0) (2026-07-06)


### Features

* **studio:** chat slice, Preact assistant panel, multi-root-safe agentic edits ([#984](https://github.com/Atypical-Consulting/Koine/issues/984), [#990](https://github.com/Atypical-Consulting/Koine/issues/990), [#472](https://github.com/Atypical-Consulting/Koine/issues/472)) ([#1119](https://github.com/Atypical-Consulting/Koine/issues/1119)) ([1004950](https://github.com/Atypical-Consulting/Koine/commit/10049509bbb4cb1f99c6ce0046a6007bc103d3ce))


### Bug Fixes

* **emit-core:** honor explicit qualifier + map-permission in flat-module owner resolution ([#1124](https://github.com/Atypical-Consulting/Koine/issues/1124)) ([#1128](https://github.com/Atypical-Consulting/Koine/issues/1128)) ([9bc7735](https://github.com/Atypical-Consulting/Koine/commit/9bc7735e46303174942c9ebf451e587e94737abf))
* **emit:** qualify multi-owner cross-context type references; consolidate shared emitter infra ([#1091](https://github.com/Atypical-Consulting/Koine/issues/1091)) ([#1120](https://github.com/Atypical-Consulting/Koine/issues/1120)) ([3c37068](https://github.com/Atypical-Consulting/Koine/commit/3c3706886f291a72a528597af68035199c5a1419))

## [0.246.0](https://github.com/Atypical-Consulting/Koine/compare/v0.245.0...v0.246.0) (2026-07-06)


### Features

* **emit-cs:** adoptable application-layer handlers, Mapperly mapping & an ASP.NET api layer ([#1036](https://github.com/Atypical-Consulting/Koine/issues/1036)) ([fd9b705](https://github.com/Atypical-Consulting/Koine/commit/fd9b70547eb6b5dce68bdd76265cc38fdb76d3ce))
* **emit-java:** add a dependency-free Java 17 emitter target ([#858](https://github.com/Atypical-Consulting/Koine/issues/858)) ([#1069](https://github.com/Atypical-Consulting/Koine/issues/1069)) ([c30d837](https://github.com/Atypical-Consulting/Koine/commit/c30d83742b5aa2633ce59c237986176189550504))
* **emit-kt:** add a Kotlin emitter target ([#1066](https://github.com/Atypical-Consulting/Koine/issues/1066)) ([#1092](https://github.com/Atypical-Consulting/Koine/issues/1092)) ([014c412](https://github.com/Atypical-Consulting/Koine/commit/014c412d826408f13259a523fa255183630d57d9))
* **emit-kt:** defensively copy collection members in value objects ([#1110](https://github.com/Atypical-Consulting/Koine/issues/1110)) ([#1114](https://github.com/Atypical-Consulting/Koine/issues/1114)) ([e3a3cc3](https://github.com/Atypical-Consulting/Koine/commit/e3a3cc3c98c76f8d529b98a6fda9b71e333293a8))
* **emit-rust:** demand-driven value-object add/subtract for plain value +/- value ([#887](https://github.com/Atypical-Consulting/Koine/issues/887)) ([#1062](https://github.com/Atypical-Consulting/Koine/issues/1062)) ([991b24e](https://github.com/Atypical-Consulting/Koine/commit/991b24e3ea139dec4a52f575ad3534351cc30b32))
* **emit-ts:** truncate Int fields toward zero on scalar multiply/divide ([#938](https://github.com/Atypical-Consulting/Koine/issues/938)) ([#1032](https://github.com/Atypical-Consulting/Koine/issues/1032)) ([ab1d8f4](https://github.com/Atypical-Consulting/Koine/commit/ab1d8f458ad4bfae6fe01c839366e851b8a07400))
* **studio:** add a syntax-tree visualizer panel to the right rail ([#890](https://github.com/Atypical-Consulting/Koine/issues/890)) ([#1085](https://github.com/Atypical-Consulting/Koine/issues/1085)) ([b32612c](https://github.com/Atypical-Consulting/Koine/commit/b32612c631eb127deafbf51174e8dca5c0e61030))
* **studio:** add an ESLint gate enforcing frontend safety conventions ([#978](https://github.com/Atypical-Consulting/Koine/issues/978)) ([#993](https://github.com/Atypical-Consulting/Koine/issues/993)) ([f676bc8](https://github.com/Atypical-Consulting/Koine/commit/f676bc835049c75095000faf0c19c541e5a13497))
* **studio:** clarify + recover the empty (non-Koine) clone outcome ([#1017](https://github.com/Atypical-Consulting/Koine/issues/1017)) ([#1058](https://github.com/Atypical-Consulting/Koine/issues/1058)) ([f714939](https://github.com/Atypical-Consulting/Koine/commit/f714939e557038c1cb387eaefc8c7061023cd226))
* **studio:** preserve syntax-tree roving focus across panel refetch ([#1097](https://github.com/Atypical-Consulting/Koine/issues/1097)) ([#1100](https://github.com/Atypical-Consulting/Koine/issues/1100)) ([ec33ba6](https://github.com/Atypical-Consulting/Koine/commit/ec33ba65ffb22a44ba477a1ab02c7a1830e98858))
* **studio:** recreate the full-bleed Home with resume card, dense recents & Clone ([#1005](https://github.com/Atypical-Consulting/Koine/issues/1005)) ([#1006](https://github.com/Atypical-Consulting/Koine/issues/1006)) ([aca2b5d](https://github.com/Atypical-Consulting/Koine/commit/aca2b5dc573287b994db11a906cc19ed7b5bcd30))
* **studio:** sticky ancestors band for the virtualized syntax-tree panel ([#1106](https://github.com/Atypical-Consulting/Koine/issues/1106)) ([#1108](https://github.com/Atypical-Consulting/Koine/issues/1108)) ([424ba5d](https://github.com/Atypical-Consulting/Koine/commit/424ba5d0ef6f5ad3d5710d9538ed347724b58e51))
* **studio:** type-check the koine-ui⇄koine-studio DOM-id contract via shared constants ([#979](https://github.com/Atypical-Consulting/Koine/issues/979)) ([#999](https://github.com/Atypical-Consulting/Koine/issues/999)) ([83bd203](https://github.com/Atypical-Consulting/Koine/commit/83bd2036b363393ec3a590ff15ae6b997edc0f5a))
* **studio:** virtualize the syntax-tree panel + raise serializer MaxDepth ([#1098](https://github.com/Atypical-Consulting/Koine/issues/1098)) ([#1101](https://github.com/Atypical-Consulting/Koine/issues/1101)) ([ad2c262](https://github.com/Atypical-Consulting/Koine/commit/ad2c26267594aa33589050e74cf28b872d430583))


### Bug Fixes

* **deps:** update dependency @anthropic-ai/sdk to ^0.110.0 ([#1013](https://github.com/Atypical-Consulting/Koine/issues/1013)) ([1593d89](https://github.com/Atypical-Consulting/Koine/commit/1593d898bdc1eda066d28aa8a1ca7603c4a31939))
* **emit-kt:** backtick-escape keyword package segments in Kotlin output ([#1109](https://github.com/Atypical-Consulting/Koine/issues/1109)) ([#1111](https://github.com/Atypical-Consulting/Koine/issues/1111)) ([39b70a9](https://github.com/Atypical-Consulting/Koine/commit/39b70a91efd890e4ca85e97ae019d7a8b5a6bf83))
* **emit-php:** emit computed Decimal defaults as valid PHP in const-required positions ([#971](https://github.com/Atypical-Consulting/Koine/issues/971)) ([#1025](https://github.com/Atypical-Consulting/Koine/issues/1025)) ([e999d64](https://github.com/Atypical-Consulting/Koine/commit/e999d642e0a99f4bfd7e9887de36e17ac26e02c4))
* **emit-php:** re-box a bare Int-literal default on a Decimal member ([#1030](https://github.com/Atypical-Consulting/Koine/issues/1030)) ([#1035](https://github.com/Atypical-Consulting/Koine/issues/1035)) ([78fe2d6](https://github.com/Atypical-Consulting/Koine/commit/78fe2d6fc00f154ee0cbf43a5930a2ec55d2b43d))
* **emit-rust:** lift impl Add over Option for optional numeric fields in sum-folded value objects ([#970](https://github.com/Atypical-Consulting/Koine/issues/970)) ([#1021](https://github.com/Atypical-Consulting/Koine/issues/1021)) ([16441dc](https://github.com/Atypical-Consulting/Koine/commit/16441dc1969e024c75e30247d60affc761f54a46))
* **emit-rust:** route a quantity's plain +/- through unit-checked add/sub ([#1068](https://github.com/Atypical-Consulting/Koine/issues/1068)) ([#1080](https://github.com/Atypical-Consulting/Koine/issues/1080)) ([9a3e02c](https://github.com/Atypical-Consulting/Koine/commit/9a3e02c7a85d207ad7437932537dd4a058b076be))
* **semantics:** catch division by zero nested in conditional/coalesce/let member defaults ([#1048](https://github.com/Atypical-Consulting/Koine/issues/1048)) ([#1049](https://github.com/Atypical-Consulting/Koine/issues/1049)) ([09e1083](https://github.com/Atypical-Consulting/Koine/commit/09e10836617f9f942a47dec10cf3be059a95700b))
* **semantics:** fire KOI0217 for narrowing on stored constant defaults, not just derived members ([#974](https://github.com/Atypical-Consulting/Koine/issues/974)) ([#1020](https://github.com/Atypical-Consulting/Koine/issues/1020)) ([6145507](https://github.com/Atypical-Consulting/Koine/commit/6145507738fc744f607985cf206145221c6fc780))
* **semantics:** infer a conditional as its branches' common numeric type so KOI0217 catches a narrowing else ([#975](https://github.com/Atypical-Consulting/Koine/issues/975)) ([#1033](https://github.com/Atypical-Consulting/Koine/issues/1033)) ([3360648](https://github.com/Atypical-Consulting/Koine/commit/3360648dc8107e34f20b8693341c4cb1f630e668))
* **semantics:** rebuild KOI1606's zero-divisor walker on ExprWalker for exhaustive Expr coverage ([#1056](https://github.com/Atypical-Consulting/Koine/issues/1056)) ([#1070](https://github.com/Atypical-Consulting/Koine/issues/1070)) ([b1e742b](https://github.com/Atypical-Consulting/Koine/commit/b1e742bd2ce1d7d5b323b10898e0a50ca30366dd))
* **semantics:** reject division by zero in a constant-foldable default expression ([#1031](https://github.com/Atypical-Consulting/Koine/issues/1031)) ([#1045](https://github.com/Atypical-Consulting/Koine/issues/1045)) ([cea5948](https://github.com/Atypical-Consulting/Koine/commit/cea5948ba6bdb550659886b495e1b1ab43177ced))
* **studio:** bail in-flight surface loaders after inspectorController dispose ([#1002](https://github.com/Atypical-Consulting/Koine/issues/1002)) ([#1029](https://github.com/Atypical-Consulting/Koine/issues/1029)) ([a7217e3](https://github.com/Atypical-Consulting/Koine/commit/a7217e3da33434d53f5bd5e3a6bf13a45ea9e1c6))
* **studio:** bail refreshContextList() after inspectorController dispose() so a resolving glossary fetch can't write a torn-down controller's state ([#1037](https://github.com/Atypical-Consulting/Koine/issues/1037)) ([#1047](https://github.com/Atypical-Consulting/Koine/issues/1047)) ([c6af3ae](https://github.com/Atypical-Consulting/Koine/commit/c6af3ae03a7b9c52538c8c5a4828cb552a6f1530))
* **studio:** guard applyFileEdit dirty-clear against a mid-write keystroke ([#1008](https://github.com/Atypical-Consulting/Koine/issues/1008)) ([#1050](https://github.com/Atypical-Consulting/Koine/issues/1050)) ([619eafc](https://github.com/Atypical-Consulting/Koine/commit/619eafcee453d74c30fa43f737daa03eed1899fe))
* **studio:** guard applyFileEdit's didSave against a stale write ([#1081](https://github.com/Atypical-Consulting/Koine/issues/1081)) ([#1087](https://github.com/Atypical-Consulting/Koine/issues/1087)) ([8da8b61](https://github.com/Atypical-Consulting/Koine/commit/8da8b61f19c4b8fe0455da70b1af2834938e691a))
* **studio:** guard saveActive/saveAllDirty didSave against a mid-write buffer switch ([#1009](https://github.com/Atypical-Consulting/Koine/issues/1009)) ([#1052](https://github.com/Atypical-Consulting/Koine/issues/1052)) ([d1916a3](https://github.com/Atypical-Consulting/Koine/commit/d1916a379dd692873e07bcd7cee81b42cea54e82))
* **studio:** guard saveAllDirty's didSave against a write failure on the active buffer ([#1055](https://github.com/Atypical-Consulting/Koine/issues/1055)) ([#1078](https://github.com/Atypical-Consulting/Koine/issues/1078)) ([cfe04e4](https://github.com/Atypical-Consulting/Koine/commit/cfe04e4b3b89e1e552b6fcb4596d15160dca8598))
* **studio:** guard shared-workspace import against a concurrent Home workspace swap ([#1046](https://github.com/Atypical-Consulting/Koine/issues/1046)) ([#1083](https://github.com/Atypical-Consulting/Koine/issues/1083)) ([7b3f710](https://github.com/Atypical-Consulting/Koine/commit/7b3f7106556d350a094442da3eb607e28abe97c2))
* **studio:** re-dispatch the queued Home start-intent when the desktop LSP fails to start ([#973](https://github.com/Atypical-Consulting/Koine/issues/973)) ([#1038](https://github.com/Atypical-Consulting/Koine/issues/1038)) ([7ed2e04](https://github.com/Atypical-Consulting/Koine/commit/7ed2e04d678fa2699815504aca967566edc7bfc9))
* **studio:** release leaked store subscriptions and timers on shell teardown ([#980](https://github.com/Atypical-Consulting/Koine/issues/980)) ([#1000](https://github.com/Atypical-Consulting/Koine/issues/1000)) ([ecce6d2](https://github.com/Atypical-Consulting/Koine/commit/ecce6d2a97e867551a85de98f0c4bdd335d869dc))
* **studio:** select the clicked syntax-tree node on the first click ([#1116](https://github.com/Atypical-Consulting/Koine/issues/1116)) ([#1118](https://github.com/Atypical-Consulting/Koine/issues/1118)) ([5d776d7](https://github.com/Atypical-Consulting/Koine/commit/5d776d72a73744914777b7a61af32a6f7ad33927))
* **studio:** tag recents with the folder's effective emit language, not the stale store value ([#1015](https://github.com/Atypical-Consulting/Koine/issues/1015)) ([#1067](https://github.com/Atypical-Consulting/Koine/issues/1067)) ([34142ff](https://github.com/Atypical-Consulting/Koine/commit/34142ff276e04efbb0e9ca75aa80f4636b9410c0))
* **studio:** tag the clone flow's recent entry with its own effective emit language ([#1072](https://github.com/Atypical-Consulting/Koine/issues/1072)) ([#1074](https://github.com/Atypical-Consulting/Koine/issues/1074)) ([8b9388d](https://github.com/Atypical-Consulting/Koine/commit/8b9388dffedb9de965d67ccb283734540b59c2ff))
* **tests:** drain TestSupport siblings' stdout/stderr concurrently ([#1053](https://github.com/Atypical-Consulting/Koine/issues/1053)) ([#1054](https://github.com/Atypical-Consulting/Koine/issues/1054)) ([546bdc3](https://github.com/Atypical-Consulting/Koine/commit/546bdc3ff2f303b2ea1b96226b8f34707013a8fd))
* **tests:** read RunProcess stdout/stderr concurrently to avoid a pipe-buffer deadlock ([#1034](https://github.com/Atypical-Consulting/Koine/issues/1034)) ([#1051](https://github.com/Atypical-Consulting/Koine/issues/1051)) ([6639bd4](https://github.com/Atypical-Consulting/Koine/commit/6639bd4d46c45427a0492fbd249884e2d1bc1917))

## [0.245.0](https://github.com/Atypical-Consulting/Koine/compare/v0.244.0...v0.245.0) (2026-07-02)


### ⚠ BREAKING CHANGES

* **emit:** extract each emitter into its own Koine.Emit.<Target> project ([#861](https://github.com/Atypical-Consulting/Koine/issues/861)) (#968)

### Features

* demand-generate value-object / scalar division in TS, Python, and Rust emitters ([#879](https://github.com/Atypical-Consulting/Koine/issues/879)) ([#933](https://github.com/Atypical-Consulting/Koine/issues/933)) ([5d09c3a](https://github.com/Atypical-Consulting/Koine/commit/5d09c3a744257c5aaec74cb4187e01f8e86f8d7a))
* **design-sync:** ship Koine Studio panels as live components via a Preact→React adapter ([#913](https://github.com/Atypical-Consulting/Koine/issues/913)) ([3dabd10](https://github.com/Atypical-Consulting/Koine/commit/3dabd1083c3676ca9423a09a7343d797cdb9f9dc))
* **emit:** extract each emitter into its own Koine.Emit.&lt;Target&gt; project ([#861](https://github.com/Atypical-Consulting/Koine/issues/861)) ([#968](https://github.com/Atypical-Consulting/Koine/issues/968)) ([9169d5e](https://github.com/Atypical-Consulting/Koine/commit/9169d5ed98b253e25b8ff40d16e24c07305e02ef))
* **studio:** add an Initialize Repository button to the Source Control panel ([#911](https://github.com/Atypical-Consulting/Koine/issues/911)) ([05af580](https://github.com/Atypical-Consulting/Koine/commit/05af58035a86b39cbfd499bbd4fe4dc9a4dd5cec))
* **studio:** adopt Concept Colors — one DDD concept, one color everywhere ([#936](https://github.com/Atypical-Consulting/Koine/issues/936)) ([#941](https://github.com/Atypical-Consulting/Koine/issues/941)) ([dfe7a94](https://github.com/Atypical-Consulting/Koine/commit/dfe7a943532deeb024d270d80d3a774d87fd4288))
* **studio:** default desktop workspace root to Documents/Koine ([#915](https://github.com/Atypical-Consulting/Koine/issues/915)) ([#949](https://github.com/Atypical-Consulting/Koine/issues/949)) ([78633da](https://github.com/Atypical-Consulting/Koine/commit/78633dafa62bc1beaf87ea4d532423f03a7c5d77))
* **studio:** extract Studio's reusable UI into @atypical/koine-ui ([#905](https://github.com/Atypical-Consulting/Koine/issues/905)) ([#932](https://github.com/Atypical-Consulting/Koine/issues/932)) ([7011c55](https://github.com/Atypical-Consulting/Koine/commit/7011c55531484a736c344b28d11b2de5f0507ce1))
* **studio:** redesign the top bar & status bar chrome (chrome v2) ([#923](https://github.com/Atypical-Consulting/Koine/issues/923)) ([#924](https://github.com/Atypical-Consulting/Koine/issues/924)) ([8f338a3](https://github.com/Atypical-Consulting/Koine/commit/8f338a3315c954697214cce8fd1e94137e0eac15))
* **studio:** ship-ready desktop MCP exposure and expandable tool-call cards ([#934](https://github.com/Atypical-Consulting/Koine/issues/934)) ([#935](https://github.com/Atypical-Consulting/Koine/issues/935)) ([8fd3cef](https://github.com/Atypical-Consulting/Koine/commit/8fd3cefad47bd81cca08048e6ae068272720ad84))


### Bug Fixes

* **design-sync:** drop orphan .d.ts and classify structural tokens ([#920](https://github.com/Atypical-Consulting/Koine/issues/920)) ([bb805e4](https://github.com/Atypical-Consulting/Koine/commit/bb805e46567943a42a834c177d649e54d0da5924))
* **emit-php:** parenthesise (new Decimal('n'))-&gt;… for a Decimal-literal receiver in WriteAsDecimal ([#907](https://github.com/Atypical-Consulting/Koine/issues/907)) ([#963](https://github.com/Atypical-Consulting/Koine/issues/963)) ([cdc2553](https://github.com/Atypical-Consulting/Koine/commit/cdc255312d76fa4d4dc1f586ab005a2d92840ad6))
* **emit-php:** parenthesise WriteAsDecimal fallthrough arm's new-chaining for Int members ([#849](https://github.com/Atypical-Consulting/Koine/issues/849)) ([#903](https://github.com/Atypical-Consulting/Koine/issues/903)) ([05579dd](https://github.com/Atypical-Consulting/Koine/commit/05579ddb91a5443ee6c77460c105b7874c5bad69))
* **emit-rust:** coerce a derived member's body to its declared numeric type ([#961](https://github.com/Atypical-Consulting/Koine/issues/961)) ([#967](https://github.com/Atypical-Consulting/Koine/issues/967)) ([fc83bcf](https://github.com/Atypical-Consulting/Koine/commit/fc83bcf5feb4f319cf807c43b87d3ce9ca1c7fca))
* **emit-rust:** map over Option for optional numeric fields scaled/divided by a scalar ([#960](https://github.com/Atypical-Consulting/Koine/issues/960)) ([#964](https://github.com/Atypical-Consulting/Koine/issues/964)) ([3cf4425](https://github.com/Atypical-Consulting/Koine/commit/3cf4425ebaee8e14c2cc92ea860749d565662b47))
* **emit-rust:** scale & divide an Int field by a Decimal scalar via coerce-and-truncate ([#937](https://github.com/Atypical-Consulting/Koine/issues/937)) ([#952](https://github.com/Atypical-Consulting/Koine/issues/952)) ([9a1ae00](https://github.com/Atypical-Consulting/Koine/commit/9a1ae00c0df2a6e84423503b5e417ecd0071d8ad))
* **scripts:** preserve caller's working directory in ps1 scripts ([#912](https://github.com/Atypical-Consulting/Koine/issues/912)) ([cabb776](https://github.com/Atypical-Consulting/Koine/commit/cabb77628b77eab91f28d2ce4dd13c3bb865e3ea))
* **semantics:** reject reversed scalar / value-object division ([#878](https://github.com/Atypical-Consulting/Koine/issues/878)) ([#906](https://github.com/Atypical-Consulting/Koine/issues/906)) ([2565bec](https://github.com/Atypical-Consulting/Koine/commit/2565becf05bce00fedda1200175b197e91f06556))
* **semantics:** reject scalar arithmetic on a value object with no numeric field ([#939](https://github.com/Atypical-Consulting/Koine/issues/939)) ([#951](https://github.com/Atypical-Consulting/Koine/issues/951)) ([11d2feb](https://github.com/Atypical-Consulting/Koine/commit/11d2feb63fe49456ec6cea6f97c5b2f85b3d4266))
* **studio:** gate cold-boot start-intent on lsp.start() to fix "LSP not started" ([#955](https://github.com/Atypical-Consulting/Koine/issues/955)) ([d3a6044](https://github.com/Atypical-Consulting/Koine/commit/d3a604418c73ddc5554ad3d4ca1b7ae5878a43e4))
* **studio:** intermittent Windows CI failure in inspectorController.test.ts ([#848](https://github.com/Atypical-Consulting/Koine/issues/848)) ([#904](https://github.com/Atypical-Consulting/Koine/issues/904)) ([bbf54b5](https://github.com/Atypical-Consulting/Koine/commit/bbf54b5b86cb214bbb0004a309e636df2388fd24))
* **studio:** key mcp_endpoint cache on the requested port ([#947](https://github.com/Atypical-Consulting/Koine/issues/947)) ([#953](https://github.com/Atypical-Consulting/Koine/issues/953)) ([847fcf1](https://github.com/Atypical-Consulting/Koine/commit/847fcf10d9ecbc65f5a363429e7eea742b11c175))
* **studio:** paint Concept Colors & semantic tokens over the grammar highlighter ([#962](https://github.com/Atypical-Consulting/Koine/issues/962)) ([bd01db0](https://github.com/Atypical-Consulting/Koine/commit/bd01db0c9b9d404c155888e51d7052fd685f973b))
* **studio:** reject the zero-byte placeholder when resolving the bundled koine sidecar ([#969](https://github.com/Atypical-Consulting/Koine/issues/969)) ([225bf74](https://github.com/Atypical-Consulting/Koine/commit/225bf74f21e52af208ba9892f6235e395a142e23))
* **studio:** repair 30 verified bugs across shell, hosts, editor, AI, and panels ([#930](https://github.com/Atypical-Consulting/Koine/issues/930)) ([badb772](https://github.com/Atypical-Consulting/Koine/commit/badb772b622575d9e3f241fbb3fc625b5c47f17b))
* **studio:** sync desktop/package version with the Koine release version ([#957](https://github.com/Atypical-Consulting/Koine/issues/957)) ([3faf88e](https://github.com/Atypical-Consulting/Koine/commit/3faf88e10e9d257005c06893251b98d5e6af2029))
* **website:** serve /blog/rss.xml under trailingSlash:always to unblock the docs deploy ([#948](https://github.com/Atypical-Consulting/Koine/issues/948)) ([#954](https://github.com/Atypical-Consulting/Koine/issues/954)) ([6c94b1a](https://github.com/Atypical-Consulting/Koine/commit/6c94b1a0513620cb041874bc06248be2e5157d4a))

## [0.244.0](https://github.com/Atypical-Consulting/Koine/compare/v0.243.0...v0.244.0) (2026-07-01)


### Features

* **gbnf:** require whitespace at word-to-word boundaries + character-level engine test ([#448](https://github.com/Atypical-Consulting/Koine/issues/448)) ([#896](https://github.com/Atypical-Consulting/Koine/issues/896)) ([27f8309](https://github.com/Atypical-Consulting/Koine/commit/27f83091a39ac4a63caaafe3cb6f3cce0603151b))
* **wasm:** warm remaining interop handlers (EmitPreview, Completions, WorkspaceSymbols, CodeActions, EmitKoine, ApplyModelEdit) ([#464](https://github.com/Atypical-Consulting/Koine/issues/464)) ([#895](https://github.com/Atypical-Consulting/Koine/issues/895)) ([4c732ff](https://github.com/Atypical-Consulting/Koine/commit/4c732ff76ab31feb61ed80733ba6d8b089ea2a7f))
* **wasm:** warm remaining interop handlers (EmitPreview, Completions, WorkspaceSymbols, CodeActions, EmitKoine, ApplyModelEdit) ([#464](https://github.com/Atypical-Consulting/Koine/issues/464)) ([#895](https://github.com/Atypical-Consulting/Koine/issues/895)) ([e3cc6de](https://github.com/Atypical-Consulting/Koine/commit/e3cc6dec877f46aca996a935cb5b0295e193ec82))

## [Unreleased]

### Added
- **Koine Studio — Initialize Repository button in the Source Control panel.** The Source Control
  panel's not-a-repo empty state no longer tells the Domain Developer to run `git init` themselves —
  it now offers an **Initialize Repository** button that shells `git init` on the open workspace folder
  and, on success, transitions the panel straight into the freshly-initialized (clean) repo, with no
  extra wiring beyond the panel's existing post-mutation reload. Desktop-only, following the same
  `canUseGit`-gated pattern as every other git verb (issue #859; completes the Source Control panel
  from #272).
- **Koine Studio — workspace settings.json now uses the same grouped key shape as user settings.json.**
  The workspace scope of the Settings JSON editor (User / Workspace scope toggle introduced in #736) now
  uses the same `group.docKey` key shape as the user scope: `preview.target`, `editor.formatOnSave`,
  `editor.wordWrap`, and `lsp.trace` instead of the previous flat runtime keys (`previewTarget`, etc.).
  This means a field can be copy-pasted between the User and Workspace editors without any key-shape
  change — the cross-scope consistency wart flagged by a reviewer on #781 is resolved. The internal
  `koine.studio.wsOverrides.*` localStorage blobs keep their flat runtime-key format and are unaffected;
  the `jsonDocToWorkspaceOverrides` parser accepts both the new grouped format and the old flat format, so
  existing saved workspace-override documents continue to load without data loss. (issue #792;
  follow-up to #736 and #750)
- **Koine Studio — "On startup" setting (Home vs Last workspace).** A new **Settings → Appearance → On
  startup** dropdown lets power users opt into reopening the last workspace automatically on a cold
  Studio boot, reversing the always-Home default introduced by #766 without affecting it for everyone
  else. The default remains `Home screen` (no change in behaviour for users who don't touch the
  setting). Choosing `Last workspace` auto-resumes the editor when a prior workspace exists; a pristine
  first-load (no prior workspace) still lands on Home so the user is never stranded on a blank editor.
  Explicit `#/editor` deep-links and `#model=…` share links continue to win regardless of the setting.
  The boot resolver (`resolveInitialRoute`) stays pure / IO-free — the setting and the persisted-
  workspace flag are passed in by `main.ts` at the only IO boundary, preserving the no-flash contract
  from #368. The `startupView: 'home' | 'lastWorkspace'` field is persisted in Settings and exposed in
  the Settings JSON editor for advanced users. (issue #770; follow-up to #766 / #768)

### Changed
- **Koine Studio Web now always opens on Home.** Opening Studio (a cold load at the base URL / `#/`) lands
  on the Home start console every time instead of auto-skipping a returning user straight into the editor —
  the persisted "workspace was opened" flag is no longer a routing input (issue #766). The returning-user
  fast path is preserved as a one-click **Resume** control on a cold-open Home, so getting back to the last
  workspace is now a deliberate choice rather than an automatic jump. Explicit `#/editor` deep-links (and
  same-tab editor refreshes) and `#model=…` share links still open the editor, and #368's no-flash,
  single-view boot is unchanged.

### Fixed
- **C# emitter: direct same-type `value + value` / `value - value` validated but emitted CS0019.** A plain
  (non-`quantity`) value object combined with another of its own type *directly* — `total: Money = fee + fee`
  or `diff: Money = fee - fee`, written outside a `sum` fold — passed validation but emitted C# that called
  operators the emitter never generated (two CS0019s): `operator +` was demand-generated only by a `sum`
  fold, and `operator -` was never generated for plain value objects at all. The C# emitter now records the
  direct-binary additive/subtractive need (reusing the existing `BuildValueObjectArithmeticNeeds` analysis,
  the same map the PHP emitter consumes) and demand-generates `operator +`/`operator -` for plain value
  objects, mirroring scalar `*`/`/` (#832) and the `sum`-fold `+`. Both route through the validating
  constructor, so e.g. a negative difference still throws the declared `invariant` at construction. The fix
  is C#-emitter-only; no grammar, parser, or `Ast/` change, and no change to other targets (issue #833).
- **Live Playground compiler failed to boot ("Koine worker timed out after 30s").** The marketing-site
  Playground's in-browser compiler hung at boot: its wasm Web Worker installed the message loop with a
  top-level `self.onmessage = …`, which clobbers the `message` channel the .NET WebAssembly runtime
  installs while `dotnet.create()` boots inside a Worker, so the boot never settled (no `ready`, no
  `boot-failure`) and the host waited out its 30s timer (issue #492). This is the exact #357/#358 Studio
  hang, re-introduced on the un-ported website copy. Ported the proven Studio fix: the worker now
  installs its RPC loop via `self.addEventListener('message', …)` **after** `dotnet.create()` resolves,
  never as a top-level `self.onmessage =`. Added a headless-Chromium boot smoke test
  (`website/scripts/smoke-boot.mjs`) that boots the real deploy bundle and asserts the compiler reaches
  `ready` and round-trips a compile — wired into the docs deploy as a gate so a non-booting worker can
  never ship silently again.

### Added
- **Koine Studio — Settings JSON `User | Workspace` scope toggle.** The Settings JSON view now has a
  VS Code-style **User | Workspace** segmented toggle above the editor, so the four workspace-scopable
  fields (`previewTarget`, `formatOnSave`, `wordWrap`, `lspTrace`) can be hand-edited per workspace in a
  flat `settings.json` overlay without touching the global user settings. The `Workspace` pill is
  disabled with an empty-state note ("Open a folder to edit workspace settings") when no workspace is
  open; switching scope re-seeds the editor with the appropriate document; valid edits are persisted to a
  per-workspace `wsOverrides` blob and live-applied via `effectiveSettings`; removing a key from the
  workspace doc reverts that field to the user value (issue #736).
- **Koine Studio — Settings JSON reorganized into VS Code-style namespaced groups (+ new options).** The
  editable `settings.json` document is now grouped under `appearance` / `editor` / `ai` / `mcp` / `preview` /
  `lsp` / `account` namespaces instead of a flat bag of keys, so hand-edits are easy to scan and a new setting
  has an obvious home (issue #750). A single declarative field map (`runtimeKey → group.docKey`) is the source
  of truth driving the serializer, the nested JSON Schema (with per-field `title`/`description` metadata), the
  parser, and a three-way parity test in lockstep. The runtime `Settings` type stays **flat**, so there is no
  localStorage migration and no churn to existing read sites — only the document the user edits is grouped — and
  an old/hand-saved **flat** document still parses through a legacy fallback. The encrypted AI API key remains
  absent from the schema and document (re-injected on save). Ships three new, fully-wired options: **`editor.tabSize`**
  (indent width 1–8, applied as the editor's indent unit / tab width), **`appearance.fontFamily`** (an editor
  font-stack override; blank uses the theme default), and **`ai.temperature`** (0–2 sampling temperature sent on
  every assistant request) — each with a runtime coercer, a real consumer, and a Visual-pane control.
- **Koine Studio — Settings is now a gear-launched center page (Visual/JSON).** The toolbar gear opens
  Settings as a transient center view (a peer of Visual/Code/Documentation) rather than a modal, with a
  **Visual/JSON** segmented toggle in the page header. The Visual side is the same two-pane preference form
  as before; the new **JSON** side is a schema-validated, editable `settings.json` whose valid edits
  live-apply through the very same `onChange` hook the Visual controls commit through (an invalid document
  surfaces a diagnostics strip and is never saved). The encrypted AI API key stays encrypted and never
  appears in the JSON — it is stripped from the serialized document and re-injected on save.
- **Playground — graceful boot degradation (watchdog + main-thread fallback).** The marketing-site
  Playground now survives a worker boot that goes wrong for any reason (a future runtime regression, an
  exotic browser, a corrupted cached bundle), not just the #492 channel-clobber. The wasm worker carries
  a **boot watchdog**: if `dotnet.create()` neither resolves nor rejects within ~20s it posts an explicit
  `boot-failure`, so the host fails fast with a named diagnostic instead of silently waiting out its 30s
  timer. And the host now has a **guarded main-thread fallback** — when the worker never reaches `ready`,
  the compiler boots on the UI thread instead so the Playground still works (a large compile may briefly
  freeze the page) rather than bricking. The worker stays the fast path; the fallback fires only as the
  safety net, mirroring Koine Studio's shipped #357/#358 resilience (issue #510).
- **Koine Studio — Source Control (git) panel.** A new right-rail **Source Control** view brings git into
  the IDE for `.koi` models kept under version control (issue #272): the current branch with a switcher,
  changed files grouped into **Staged** / **Changes** / **Untracked** with per-row stage/unstage and an
  inline diff, a commit box, and the recent-commit log. Git is a host capability behind a new `canUseGit`
  flag on `Platform` — the desktop (Tauri) host shells `git` in the opened folder via new `git_*` sidecar
  commands (`git_status`/`git_diff`/`git_stage`/`git_unstage`/`git_commit`/`git_branches`/`git_checkout`/
  `git_log`), while the browser host (no shell) degrades gracefully to a "desktop only" empty state, and a
  non-repo folder shows a "not a git repository" empty state. This is the umbrella git plumbing the
  per-element inspector history (#150) reuses.
- **TypeScript & Python infrastructure layer (`--layers infrastructure`).** The opt-in
  `--layers infrastructure` selector — previously C#-only (EF Core) — now also applies to the
  **TypeScript** and **Python** targets (issue #241), closing the largest cross-emitter parity gap.
  Per bounded context with an entity-rooted aggregate, each emits a **dependency-light**, runnable
  realization of the domain contracts: a concrete repository over an injectable `AggregateStore` with a
  zero-dependency **in-memory default** (declarative finders → concrete lookups), a concrete unit of
  work, a transactional **outbox** + dispatcher (publishing contexts only), validation/transaction
  **pipeline behaviors**, and a composition-root factory (TS) / provider helper (Python). Shared
  primitives live once in an emitted `infrastructure-runtime.ts` / `koine_infrastructure.py`. Off by
  default — an unconfigured emit is byte-identical; the output is `tsc --strict` / `mypy --strict`-clean.
- **Koine Studio — aggregate-scoped palette constructs (Repository & Rule).** The visual editor's
  structured-edit seam now targets a *selected aggregate* (not only a context): a new
  `addAggregateMember` edit inserts a re-validating `aggregateMember` and re-emits the whole aggregate.
  The two muted palette buttons are activated, gated on an aggregate being selected — **Repository**
  inserts `repository { operations: add, getById }`, and **Rule** maps to an aggregate-scoped
  `spec <Name> on <Root> = true` (a named, reusable boolean rule over the root; no new grammar). A
  second repository on the same aggregate is refused; a duplicate rule name is rejected by re-validation.
- **MCP server (`koine-mcp`).** A Model Context Protocol server (`src/Koine.Mcp`) that lets an AI agent
  author a complete domain in `.koi` over stdio: `koine_validate`, `koine_compile`
  (csharp/typescript/glossary/docs), and `koine_format` tools, plus `koine_reference` and
  `koine_examples` (also exposed as `koine://` resources) so the agent learns the language. Reuses the
  same parser, validator, and emitters as `koine build`. Packaged as a `dotnet tool`.
- Documentation emitter (`--target docs`): emits Markdown with Mermaid diagrams (context maps as
  flowcharts, state machines as state diagrams, integration-event flows) — _in progress_.

## [0.17.x] — Tooling & multi-target

### Added
- **R16 — Multi-target emitters & emitter configuration.** TypeScript emitter (`--target typescript`)
  behind the same target-agnostic `IEmitter` seam as C#, plus per-target output configuration via
  `koine.config`. Generated C# is grouped into DDD "kind" subfolders.
- **R17 — Editor tooling & developer experience.** TextMate grammar for `.koi` (Rider + VS Code),
  a `koine lsp` language server (live diagnostics, completion, hover, go-to-definition across files),
  AST-scoped rename / extract-value-object refactorings, and the `fmt` / `init` / `watch` CLI commands.
- Build-time ubiquitous-language **glossary** emission (`--target glossary`).

## [0.1.0 – 0.16.x] — Core language (R1–R15)

The full tactical *and* strategic DDD toolkit on the C# emitter, delivered as releases R1–R15:

- **Tactical building blocks** — value objects, entities (`identified by`, identity strategies),
  aggregates, smart enums, derived/default fields, invariants (incl. regex `matches` and `when` guards),
  the pure expression sublanguage, factories, specifications, domain services, and policies.
- **Persistence & application layer** — repositories, optimistic concurrency (`versioned`), the
  application layer (Unit of Work, read models, CQRS queries/handlers).
- **Strategic design** — multi-file compilation, imports & modules, context maps, integration events,
  and model versioning / evolution checks.
- Self-contained `Koine.Runtime` markers emitted alongside the generated code (no external dependency).
- Snapshot (Verify) + in-memory Roslyn compile/execute meta-tests throughout.

[Unreleased]: https://github.com/Atypical-Consulting/Koine/commits/main
