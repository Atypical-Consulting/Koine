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
EVENT      : 'event' ;
EMIT       : 'emit' ;
STATES     : 'states' ;
CREATE     : 'create' ;
WHEN       : 'when' ;
IF         : 'if' ;
THEN       : 'then' ;
ELSE       : 'else' ;
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
ASSIGN : '=' ;

EQ  : '==' ;
NEQ : '!=' ;
LE  : '<=' ;
GE  : '>=' ;
LT  : '<' ;
GT  : '>' ;

RARROW : '->' ;   // state transition: `status -> Placed` (before MINUS for maximal munch)
LARROW : '<-' ;   // factory field initialization: `total <- lines.sum(...)`
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
LINE_COMMENT  : '//' ~[\r\n]* -> skip ;
BLOCK_COMMENT : '/*' .*? '*/' -> skip ;

// ---- Regex mode ------------------------------------------------------------

mode REGEX_MODE;
REGEX_WS : [ \t\r\n]+ -> skip ;
Regex    : '/' ( ~[/\r\n\\] | '\\' . )* '/' -> popMode ;
