/* vim: set sw=4 sts=4 : */
(function () {

    var estraverse = require('estraverse');

    function esqueryModule() {
        var REG = "\\s*(\\/(?:\\\\/|[^\\/])*\\/)\\s*";
        var NUM = "([+\\-]?[0-9]*\\.?[0-9]+)";
        var STR = '("(?:\\"|[^"])*")';
        var OP = "(\\*|\\.|#)";
        var S_DOP_S = "\\s*(!=|<=|>=)\\s*";
        var S_OP = "\\s*(\\]|\\)|!)";
        var OP_S = "(\\[|:)\\s*";
        var S_OP_S = "\\s*(\\,|~|<|>|=|\\+|\\||\\(|\\s)\\s*";
        var OPS = OP + "|" + S_DOP_S + "|" + S_OP + "|" + S_OP_S + "|" + OP_S;
        var TOKEN_SPLIT = new RegExp(REG + "|" + NUM + "|" + STR + "|" + OPS);

        var isArray = Array.isArray || function isArray(array) {
            return Object.prototype.toString.call(array) === '[object Array]';
        };

        /**
         * Tokenize a selector string into an array of tokens. Tokens
         * contain a type and value field.
         */
        function tokenize(selector) {
            selector = selector.replace(/^\s*|\s*$/g, "");
            var tokens = selector.split(TOKEN_SPLIT);

            tokens = tokens.filter(function (token) {
                return token;
            });

            tokens = tokens.map(function (token) {
                if (token === "*") {
                    return {
                        type: "wildcard",
                        value: "*"
                    };
                } else if (/type|not|matches|first\-child|nth\-child|nth\-last\-child|last\-child|length|calc/.test(token)) {
                    return {
                        type: "keyword",
                        value: token
                    };
                } else if (/".*"/.test(token)) {
                    return {
                        type: "string",
                        value: token.replace(/^"|"$/g, "").replace(/\\"/, "\"")
                    };
                } else if (/[+\-]?[0-9]*.?[0-9]+/.test(token)) {
                    return {
                        type: "number",
                        value: parseFloat(token)
                    };
                } else if (/\/.*\//.test(token)) {
                    return {
                        type: "regexp",
                        value: token.replace(/^\/|\/$/g, "").replace(/\\\//g, "/")
                    };
                } else if (/!=|<=|>=|<|>|,|~|=|!|:|#|\.|\+|\[|\]|\(|\)|\s/.test(token)) {
                    return {
                        type: "operator",
                        value: token
                    };
                } else {
                    return {
                        type: "identifier",
                        value: token
                    };
                }
            });

            return tokens;
        }

        /**
         * Loop through all the tokens and process them into the
         * selector AST. The selector AST is a tree containing
         * nodes representing the various elements of the selector:
         * * descendant
         * * child
         * * sibling
         * * adjacent
         * * 'and'
         * * nth-child(num)
         * * [attribute]
         */
        function processTokens(tokens) {
            var result, selector;
            while (tokens.length > 0) {
                selector = consumeComplexSelector(tokens);
                if (tokens.length > 0) {
                    var token = tokens.shift();
                    if (token.type === "operator" && token.value === ",") {
                        if (!result) {
                            result = {
                                type: "matches",
                                selectors: [selector]
                            };
                        } else {
                            result.selectors.push(selector);
                        }
                        selector = undefined;
                    } else {
                        throw createError("Invalid token, expected ',': ", token, tokens);
                    }
                } else if (selector && result) {
                    result.selectors.push(selector);
                }
            }
            return result || selector;
        }

        function peekOp(tokens, opValue) {
            if (tokens.length > 0 && peekType(tokens, "operator") &&
                    (opValue instanceof RegExp && opValue.test(tokens[0].value) ||
                    tokens[0].value === opValue)) {
                return tokens[0];
            }
        }

        function consumeOp(tokens, opValue) {
            if (peekOp(tokens, opValue)) {
                return tokens.shift();
            } else {
                throw createError("Expected operator " + opValue + ", but found: ", tokens[0], tokens);
            }
        }

        function peekType(tokens, type) {
            if (tokens.length > 0 && (tokens[0].type === type ||
                    type instanceof RegExp && type.test(tokens[0].type))) {
                return tokens[0];
            }
        }

        function consumeType(tokens, type) {
            if (peekType(tokens, type)) {
                return tokens.shift();
            } else {
                throw createError("Expected type " + type + ", but found: ", tokens[0], tokens);
            }
        }

        var operatorMap = {
            " ": "descendant",
            ">": "child",
            "~": "sibling",
            "+": "adjacent"
        };

        function consumeComplexSelector(tokens) {
            var result, selector;

            result = consumeCompoundSelector(tokens);

            while (peekOp(tokens, /[\s+~>]/)) {
                op = tokens.shift();
                selector = consumeCompoundSelector(tokens);

                if (selector) {
                    result = {
                        type: operatorMap[op.value],
                        operator: op.value,
                        left: result,
                        right: selector
                    };
                } else {
                    throw createError("Expected compound selector: ", op, tokens);
                }
            }

            return result || selector;
        }

        /**
         * Core token processor
         */
        function consumeCompoundSelector(tokens) {
            var result, selector;

            result = consumeSelector(tokens);

            while (tokens.length > 0) {
                selector = consumeSelector(tokens);
                if (selector) {
                    if (result.type !== "compound") {
                        result = {
                            type: "compound",
                            selectors: [result]
                        };
                    }

                    result.selectors.push(selector);
                } else {
                    break;
                }
            }

            return result || selector;
        }

        function consumeSelector(tokens) {
            var selector;
            if (peekType(tokens, "wildcard")) {
                selector = tokens.shift();
            } else if (peekType(tokens, /keyword|identifier/)) {
                selector = {
                    type: "identifier",
                    value: tokens.shift().value.toLowerCase()
                };
            } else if (peekOp(tokens, ":")) {
                selector = consumePseudo(tokens);
            } else if (peekOp(tokens, "[")) {
                selector = consumeAttribute(tokens);
            } else if (peekOp(tokens, ".")) {
                selector = consumeField(tokens);
            } else if (peekOp(tokens, "#")) {
                tokens.shift();
                selector = consumeType(tokens, /keyword|identifier/);
                selector = {
                    type: "identifier",
                    value: selector.value.toLowerCase()
                };
            }

            if (selector && peekOp(tokens, "!")) {
                tokens.shift();
                selector.subject = true;
            }

            return selector;
        }

        /**
         * Consume the various types of pseudo selectors (:*-child).
         */
        function consumePseudo(tokens) {
            var op = consumeOp(tokens, ":");
            var id = consumeType(tokens, "keyword");
            switch (id.value) {
            case "first-child":
                return {
                    type: "nth-child",
                    index: {
                        type: "literal",
                        value: 1
                    }
                };
            case "nth-child":
                return {
                    type: "nth-child",
                    index: consumeArg(tokens)
                };
            case "nth-last-child":
                return {
                    type: "nth-last-child",
                    index: consumeArg(tokens)
                };
            case "last-child":
                return {
                    type: "nth-last-child",
                    index: {
                        type: "literal",
                        value: 1
                    }
                };
            case "matches":
                return {
                    type: "matches",
                    selectors: consumeArgList(tokens)
                };
            case "not":
                return {
                    type: "not",
                    selectors: consumeArgList(tokens)
                };
            default:
                throw createError("Unexpected keyword: ", id, tokens);
            }
        }

        function consumeName(tokens) {
            var name = "";
            while (!name || peekOp(tokens, ".")) {
                if (name) {
                    consumeOp(tokens, ".");
                    name += ".";
                }
                name += consumeType(tokens, /keyword|identifier/).value;
            }

            return name;
        }

        /**
         * Consume an attribute selector ([])
         */
        function consumeAttribute(tokens) {
            var op = consumeOp(tokens, "[");
            var name = consumeName(tokens);

            op = consumeType(tokens, "operator");
            if (op.value === "]") {
                return {
                    type: "attribute",
                    name: name
                };
            } else {
                var selector = {
                    type: "attribute",
                    name: name,
                    operator: op.value,
                    value: consumeValue(tokens)
                };

                consumeOp(tokens, "]");
                return selector;
            }
        }

        /**
         * Consume the various types of pseudo selectors (:*-child).
         */
        function consumeField(tokens) {
            var op = consumeOp(tokens, ".");
            var name = consumeName(tokens, /keyword|identifier/);
            return {
                type: "field",
                name: name
            };
        }

        function consumeArgList(tokens) {
            consumeOp(tokens, "(");

            var arg, result = [];
            while (tokens.length > 0) {
                arg = consumeComplexSelector(tokens);
                if (arg) {
                    result.push(arg);
                } else {
                    throw createError("Expect selector argument: ", tokens[0], tokens);
                }

                if (peekOp(tokens, ",")) {
                    tokens.shift();
                } else {
                    break;
                }
            }

            consumeOp(tokens, ")");
            return result;
        }

        /**
         * Consume operator argumetns inside parens
         */
        function consumeArg(tokens) {
            consumeOp(tokens, "(");
            var value = consumeValue(tokens);
            consumeOp(tokens, ")");
            return value;
        }

        /**
         * Consume values (literals and computed values)
         */
        function consumeValue(tokens) {
            var token = tokens.shift();
            if (/number|string/.test(token.type)) {
                return {
                    type: "literal",
                    value: token.value
                };
            } else if (token.type === "regexp") {
                return {
                    type: "regexp",
                    value: new RegExp(token.value)
                };
            } else if (/keyword|type/.test(token.type) && peekOp(tokens, "(")) {
                return {
                    type: "type",
                    value: consumeArg(tokens).value
                };
            } else if (/keyword|identifier/.test(token.type)) {
                return {
                    type: "literal",
                    value: token.value
                };
            } else {
                throw createError("Unexpected token for value: ", token, tokens);
            }
        }

        /**
         * Create an error object with the supplied information.
         */
        function createError(message, token, tokens) {
            return new Error(message + JSON.stringify(token) + "\n" +
                    "Remaining tokens: " + JSON.stringify(tokens, null, "  "));
        }

        /**
         * Get the value of a property which may be multiple levels down in the object.
         */
        function getPath(obj, key) {
            var keys = key.split(".");
            var i;
            value = obj;
            for (i = 0; i < keys.length; i++) {
                if (value && value[keys[i]] !== undefined) {
                    value = value[keys[i]];
                } else {
                    return undefined;
                }
            }
            return value;
        }

        function inPath(node, ancestor, path) {
            if(path.length === 0) return node === ancestor;
            if(ancestor == null) return false;
            var field = ancestor[path[0]];
            var remainingPath = path.slice(1);
            if(isArray(field)) {
                for(var i = 0, l = field.length; i < l; ++i)
                    if(inPath(node, field[i], remainingPath))
                        return true;
                return false;
            } else {
                return inPath(node, field, remainingPath);
            }
        }

        function matches(selector, node, ancestry) {
            if(!selector) return true;
            if(!node) return false;
            if(!ancestry) ancestry = [];

            switch(selector.type) {
                case 'wildcard':
                    return true;

                case 'identifier':
                    return selector.value.toLowerCase() == node.type.toLowerCase();

                case 'field':
                    var path = selector.name.split('.');
                    var ancestor = ancestry[path.length - 1];
                    return inPath(node, ancestor, path);

                case 'matches':
                    for(var i = 0, l = selector.selectors.length; i < l; ++i)
                        if(matches(selector.selectors[i], node, ancestry))
                            return true;
                    return false;

                case 'compound':
                    for(var i = 0, l = selector.selectors.length; i < l; ++i)
                        if(!matches(selector.selectors[i], node, ancestry))
                            return false;
                    return true;

                case 'not':
                    for(var i = 0, l = selector.selectors.length; i < l; ++i)
                        if(matches(selector.selectors[i], node, ancestry))
                            return false;
                    return true;

                case 'child':
                    if(matches(selector.right, node, ancestry))
                        return matches(selector.left, ancestry[0], ancestry.slice(1));
                    return false;

                case 'descendant':
                    if(matches(selector.right, node, ancestry))
                        for(var i = 0, l = ancestry.length; i < l; ++i)
                            if(matches(selector.left, ancestry[i], ancestry.slice(i + 1)))
                                return true;
                    return false;

                case 'attribute':
                    var p = getPath(node, selector.name);
                    switch(selector.operator) {
                        case null:
                        case void 0:
                            return p != null;
                        case '=':
                            switch(selector.value.type){
                                case 'regexp': return selector.value.value.test(p);
                                case 'literal': return selector.value.value === p;
                                case 'type': return selector.value.value === typeof p;
                            }
                        case '!=':
                            switch(selector.value.type){
                                case 'regexp': return !selector.value.value.test(p);
                                case 'literal': return selector.value.value !== p;
                                case 'type': return selector.value.value !== typeof p;
                            }
                        case '<=': return p <= selector.value.value;
                        case '<': return p < selector.value.value;
                        case '>': return p > selector.value.value;
                        case '>=': return p >= selector.value.value;
                    }

                case 'sibling':
                    var parent = ancestry[0], listProp;
                    if(!parent) return false;
                    var keys = estraverse.VisitorKeys[parent.type];
                    if(matches(selector.right, node, ancestry))
                        for(var i = 0, l = keys.length; i < l; ++i)
                            if(isArray(listProp = parent[keys[i]]))
                                for(var k = 0, m = listProp.length; k < m; ++k)
                                    if(listProp[k] !== node && matches(selector.left, listProp[k], ancestry))
                                        return true;
                    return false;

                case 'adjacent':
                    var parent = ancestry[0], listProp;
                    if(!parent) return false;
                    var keys = estraverse.VisitorKeys[parent.type];
                    if(matches(selector.right, node, ancestry))
                        for(var i = 0, l = keys.length; i < l; ++i)
                            if(isArray(listProp = parent[keys[i]])) {
                                var idx = listProp.indexOf(node);
                                if(idx < 0) continue;
                                if(idx > 0 && matches(selector.left, listProp[idx - 1], ancestry))
                                    return true;
                                if(idx < listProp.length - 1 && matches(selector.left, listProp[idx + 1], ancestry))
                                    return true;
                            }
                    return false;

                case 'nth-child':
                    var parent = ancestry[0], listProp;
                    if(!parent) return false;
                    var keys = estraverse.VisitorKeys[parent.type];
                    if(matches(selector.right, node, ancestry))
                        for(var i = 0, l = keys.length; i < l; ++i)
                            if(isArray(listProp = parent[keys[i]])) {
                                var idx = listProp.indexOf(node);
                                if(idx >= 0 && idx === selector.index.value - 1)
                                    return true;
                            }
                    return false;

                case 'nth-last-child':
                    var parent = ancestry[0], listProp;
                    if(!parent) return false;
                    var keys = estraverse.VisitorKeys[parent.type];
                    if(matches(selector.right, node, ancestry))
                        for(var i = 0, l = keys.length; i < l; ++i)
                            if(isArray(listProp = parent[keys[i]])) {
                                var idx = listProp.indexOf(node);
                                if(idx >= 0 && listProp.length - idx === selector.index.value)
                                    return true;
                            }
                    return false;
            }

        }

        /**
         * This is the core match method. It takes the code AST and the selector AST
         * and returns the matching nodes of the code.
         */
        // TODO: reverse parameter order
        function match(ast, selector) {
            var ancestry = [], results = [];
            if(!selector) return results;
            estraverse.traverse(ast, {
                enter: function(node, parent){
                    ancestry.unshift(parent);
                    if(matches(selector, node, ancestry)) results.push(node);
                },
                leave: function(){ ancestry.shift(); }
            });
            return results;
        }

        /**
         * Parse a selector string and return its AST.
         */
        function parse(selector) {
            return processTokens(tokenize(selector));
        }

        /**
         * Query the code AST using the selector string.
         */
        function query(ast, selector) {
            return match(ast, parse(selector));
        }

        query.tokenize = tokenize;
        query.processTokens = processTokens;
        query.parse = parse;
        query.match = match;
        query.matches = matches;
        return query;
    }


    if (typeof define === "function" && define.amd) {
        define(esqueryModule);
    } else if (typeof module !== 'undefined' && module.exports) {
        module.exports = esqueryModule();
    } else {
        this.esquery = esqueryModule();
    }

})();
