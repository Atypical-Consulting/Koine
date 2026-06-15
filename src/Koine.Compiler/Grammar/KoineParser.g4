parser grammar KoineParser;

options { tokenVocab=KoineLexer; }

// ============================================================================
// Koine parser. Produces a parse tree consumed by KoineModelBuilderVisitor,
// which builds the target-agnostic semantic model in Ast/.
// ============================================================================

// ---- Top level -------------------------------------------------------------

program        : contextDecl* EOF ;

contextDecl    : CONTEXT Identifier LBRACE typeDecl* RBRACE ;

typeDecl       : valueDecl
               | entityDecl
               | aggregateDecl
               | enumDecl
               | eventDecl
               ;

// ---- Type declarations -----------------------------------------------------

valueDecl      : VALUE Identifier LBRACE member* invariant* RBRACE ;

entityDecl     : ENTITY Identifier IDENTIFIED BY Identifier
                 LBRACE member* invariant* statesDecl* commandDecl* RBRACE ;

// ---- State machine (legal transitions of an enum-typed lifecycle field) -----

statesDecl     : STATES softName LBRACE stateRule* RBRACE ;

stateRule      : Identifier ( RARROW Identifier ( COMMA Identifier )* )? ( WHEN expression )? ;

// ---- Commands (state-changing operations on an entity) ---------------------

commandDecl    : COMMAND Identifier ( LPAREN paramList? RPAREN )? LBRACE commandStmt* RBRACE ;

paramList      : param ( COMMA param )* ;

param          : softName COLON typeRef ;

commandStmt    : requiresClause
               | transition
               | emitClause
               ;

requiresClause : REQUIRES expression StringLiteral? ;

transition     : softName RARROW expression ;                  // `status -> Placed`

emitClause     : EMIT Identifier ( LPAREN emitArgList? RPAREN )? ;   // `emit OrderPlaced(orderId: id)`

emitArgList    : emitArg ( COMMA emitArg )* ;

emitArg        : softName COLON expression ;

aggregateDecl  : AGGREGATE Identifier ROOT Identifier LBRACE typeDecl* RBRACE ;

enumDecl       : ENUM Identifier LBRACE Identifier ( COMMA Identifier )* COMMA? RBRACE ;

// A domain event: an immutable record of something that happened. Fields only.
eventDecl      : EVENT Identifier LBRACE member* RBRACE ;

// ---- Members & invariants --------------------------------------------------

member         : softName COLON typeRef ( ASSIGN expression )? ;

// A type reference: `T`, `T?` (optional), `List<T>`, `Set<T>`, `Map<K,V>`.
typeRef        : typeName ( LT typeRef ( COMMA typeRef )? GT )? QUESTION? ;

// Soft keywords. A MEMBER NAME (declared, accessed via `.`, or a lambda
// parameter) may be (almost) any keyword — its position is unambiguous. A bare
// LEADING expression identifier additionally admits `when` (which only acts as
// the infix guard operator after a condExpr); `if/then/else` stay reserved
// there. A TYPE name is a declaration keyword. `matches`/`invariant` stay fully
// reserved (lexer mode / declaration ambiguity).
softName       : Identifier | declKeyword | WHEN | IF | THEN | ELSE ;
exprName       : Identifier | declKeyword | WHEN ;
typeName       : Identifier | declKeyword ;
declKeyword    : CONTEXT | VALUE | ENTITY | AGGREGATE | ENUM | IDENTIFIED | BY | ROOT | COMMAND | REQUIRES | EVENT | EMIT | STATES ;

invariant      : INVARIANT expression StringLiteral? ;

// ---- Expression sublanguage (small, pure, no statements/IO) ----------------
// Precedence climbs from lowest (when-guard) to highest (postfix/primary).

expression     : guardExpr ;

guardExpr      : condExpr ( WHEN condExpr )? ;                  // `<expr> when <cond>`

condExpr       : IF condExpr THEN condExpr ELSE condExpr        // `if c then a else b`
               | coalesceExpr
               ;

coalesceExpr   : orExpr ( COALESCE orExpr )* ;                  // `nickname ?? name`

orExpr         : andExpr ( OR andExpr )* ;

andExpr        : equalityExpr ( AND equalityExpr )* ;

equalityExpr   : relationalExpr ( ( EQ | NEQ ) relationalExpr )* ;

relationalExpr : matchExpr ( ( LT | LE | GT | GE ) matchExpr )* ;

matchExpr      : additiveExpr ( MATCHES Regex )? ;             // `raw matches /.../`

additiveExpr   : multiplicativeExpr ( ( PLUS | MINUS ) multiplicativeExpr )* ;

multiplicativeExpr : unaryExpr ( ( STAR | SLASH ) unaryExpr )* ;

unaryExpr      : ( NOT | MINUS ) unaryExpr
               | postfixExpr
               ;

// member access (lines.isEmpty) and operation calls (lines.all(l => l.qty > 0)).
// The member/op name after `.` may be a soft keyword (e.g. `inner.value`).
postfixExpr    : primary ( DOT softName ( LPAREN argList? RPAREN )? )* ;

argList        : argument ( COMMA argument )* ;

argument       : lambda
               | expression
               ;

lambda         : softName ARROW expression ;                   // `l => l.quantity > 0`

primary        : literal
               | exprName
               | LPAREN expression RPAREN
               ;

literal        : DecimalLiteral
               | IntLiteral
               | StringLiteral
               | BoolLiteral
               ;
