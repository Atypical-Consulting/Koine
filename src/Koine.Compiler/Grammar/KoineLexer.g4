lexer grammar KoineLexer;

// Doc comments (`///`) are kept (off the default channel) so the model builder
// can attach them to the following declaration; ordinary `//` comments are skipped.
channels { DOC }

// ============================================================================
// Koine lexer. Split from the parser so the regex sublanguage can use a lexer
// mode: after `matches`, `/.../ ` is read as a single regex literal instead of
// a pair of division operators.
// ============================================================================

// ---- Keywords --------------------------------------------------------------

CONTEXT    : 'context' ;
VALUE      : 'value' ;
QUANTITY   : 'quantity' ;
ENTITY     : 'entity' ;
AGGREGATE  : 'aggregate' ;
ENUM       : 'enum' ;
IDENTIFIED : 'identified' ;
BY         : 'by' ;
ROOT       : 'root' ;
INVARIANT  : 'invariant' ;
COMMAND    : 'command' ;
REQUIRES   : 'requires' ;
RESULT     : 'result' ;
EVENT      : 'event' ;
EMIT       : 'emit' ;
STATES     : 'states' ;
CREATE     : 'create' ;
SPEC       : 'spec' ;
ON         : 'on' ;
SERVICE    : 'service' ;
OPERATION  : 'operation' ;
POLICY     : 'policy' ;
AS         : 'as' ;
NATURAL    : 'natural' ;
SEQUENCE   : 'sequence' ;
GUID       : 'guid' ;
VERSIONED  : 'versioned' ;
REPOSITORY : 'repository' ;
OPERATIONS : 'operations' ;
FIND       : 'find' ;
USECASE    : 'usecase' ;
READMODEL  : 'readmodel' ;
FROM       : 'from' ;
QUERY      : 'query' ;
IMPORT     : 'import' ;
MODULE     : 'module' ;
// R15.1 — model versioning. `version` (the context clause keyword) must lose the
// maximal-munch tie to `versioned` (longer), which it does by length, not order.
VERSION    : 'version' ;
// R14 — context map.
CONTEXTMAP         : 'contextmap' ;
// ---- Context-map role keywords (R14) ---------------------------------------
// These are CONTEXTUAL keywords: the hyphen is part of the spelling and is the
// verbatim Evans-DDD vocabulary ('shared-kernel', 'anti-corruption-layer',
// 'open-host', ...). The general Identifier rule disallows '-' and '-' is
// otherwise MINUS, so each hyphenated role MUST be its own single literal token
// (maximal munch then never splits 'shared-kernel' into Identifier MINUS
// Identifier). This is the ONLY place hyphens are legal in the language: these
// tokens are valid solely as `relationRole`, after the ':' in a relationDecl
// (see KoineParser.g4 relationRole), and are never usable as identifiers. The
// inconsistency with the no-hyphen Identifier rule is intentional and bounded,
// not a lexing accident — matching the literature verbatim is the feature.
PARTNERSHIP        : 'partnership' ;
SHARED_KERNEL      : 'shared-kernel' ;
CUSTOMER_SUPPLIER  : 'customer-supplier' ;
CONFORMIST         : 'conformist' ;
ANTI_CORRUPTION    : 'anti-corruption-layer' ;
OPEN_HOST          : 'open-host' ;
PUBLISHED_LANGUAGE : 'published-language' ;
ACL                : 'acl' ;
// R14.3 — integration events (the 'event' word reuses the existing EVENT token).
INTEGRATION        : 'integration' ;
PUBLISHES          : 'publishes' ;
SUBSCRIBES         : 'subscribes' ;
WHEN       : 'when' ;
IF         : 'if' ;
THEN       : 'then' ;
ELSE       : 'else' ;
// R-let — expression-local bindings: `let x = e, y = e in body`. Neither `let`
// nor `in` prefixes any existing literal, so there is no maximal-munch ordering
// concern; both are added to declKeyword so existing models using them as field
// or type names keep working (they only become reserved as a LEADING expression).
LET        : 'let' ;
IN         : 'in' ;
BoolLiteral : 'true' | 'false' ;

// `matches` switches into regex mode for the following `/.../ ` literal.
MATCHES    : 'matches' -> pushMode(REGEX_MODE) ;

// ---- Punctuation & operators ----------------------------------------------

LBRACE : '{' ;
RBRACE : '}' ;
LPAREN : '(' ;
RPAREN : ')' ;
COMMA  : ',' ;
COLON  : ':' ;
DOT    : '.' ;
ARROW  : '=>' ;
COALESCE : '??' ;
QUESTION : '?' ;
AT     : '@' ;    // R15.1 — annotation prefix: `@since(2)`, `@deprecated("reason")`
ASSIGN : '=' ;

EQ  : '==' ;
NEQ : '!=' ;
LE  : '<=' ;
GE  : '>=' ;
LT  : '<' ;
GT  : '>' ;

RARROW : '->' ;   // state transition AND factory field init: `status -> Placed` / `total -> ...` (before MINUS for maximal munch)
BIARROW : '<->' ; // bidirectional context-map relation (before LT for maximal munch)
PLUS  : '+' ;
MINUS : '-' ;
STAR  : '*' ;
SLASH : '/' ;

AND : '&&' ;
OR  : '||' ;
NOT : '!' ;

// ---- Literals & identifiers -----------------------------------------------

DecimalLiteral : [0-9]+ '.' [0-9]+ ;
IntLiteral     : [0-9]+ ;
StringLiteral  : '"' ( ~["\\] | '\\' . )* '"' ;
Identifier     : [a-zA-Z_] [a-zA-Z0-9_]* ;

// ---- Trivia ----------------------------------------------------------------

WS            : [ \t\r\n]+ -> skip ;
// `///` doc comment — defined BEFORE LINE_COMMENT so it wins the maximal-munch tie.
// A 4th slash is excluded so `////…` is a longer match for LINE_COMMENT (and skipped),
// matching the C#/Rust convention that `////` is an ordinary divider comment.
DocComment    : '///' ( ~[/\r\n] ~[\r\n]* )? -> channel(DOC) ;
// Ordinary comments go to the HIDDEN channel (not `skip`) so the formatter can
// recover and preserve them; the parser only reads the default channel, so this
// does not affect parsing or any semantic behaviour.
LINE_COMMENT  : '//' ~[\r\n]* -> channel(HIDDEN) ;
BLOCK_COMMENT : '/*' .*? '*/' -> channel(HIDDEN) ;

// ---- Regex mode ------------------------------------------------------------

mode REGEX_MODE;
REGEX_WS : [ \t\r\n]+ -> skip ;
Regex    : '/' ( ~[/\r\n\\] | '\\' . )* '/' -> popMode ;
