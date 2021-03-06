
var util = require('util');
var compileUtil = require('./compileutil.js');

function CompileError(message) {
    Error.call(this);
    this.message = message;
}
util.inherits(CompileError, Error);

function CompilerContext(ancestorServices) {
    ancestorServices = ancestorServices || {};
    var localServices = {};
    var finalizeFns = [];

    function getAncestorService(role) {
        return ancestorServices[role] || null;
    }
    function addService(role, obj) {
        if (! localServices[role]) {
            localServices[role] = obj;
        }
        else {
            throw new CompileError('Two directives tried to register service role ' + role);
        }
    }
    function makeChildNodeContext() {
        var newAncestorServices = Object.create(ancestorServices);
        for (var k in localServices) {
            if (localServices.hasOwnProperty(k)) {
                newAncestorServices[k] = localServices[k];
            }
        }
        return new CompilerContext(newAncestorServices);
    }
    function onFinalize(cb) {
        finalizeFns.push(cb);
    }
    function finalize() {
        for (var i = 0; i < finalizeFns.length; i++) {
            finalizeFns[i]();
        }
    }

    this.getAncestorService = getAncestorService;
    this.addService = addService;
    this.makeChildNodeContext = makeChildNodeContext;
    this.onFinalize = onFinalize;
    // This one's not a public interface and should only be called by
    // the compiler itself.
    this.finalize = finalize;
}

function Compile(opts) {
    var parse = opts.parse;
    var interpolate = opts.interpolate;
    var directives = opts.directives || [];
    var htmlParser = opts.htmlParser;

    function compileNodeChildren(parentNode, context) {
        if (! parentNode.children) {
            return null;
        }
        var nodes = parentNode.children;
        var nodeLinkFns = [];

        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var linkFn;

            switch (node.type) {
                case 'tag':
                case 'style':
                case 'script': {
                    linkFn = makeElementLinkFn(node, context);
                } break;

                case 'text': {
                    linkFn = makeTextLinkFn(node, context);
                } break;

                case 'directive': {
                    // NOTE: This is not 'directive' in the sense our template system means it.
                    // It's the node type used for e.g. a doctype declaration.
                    linkFn = makeDoctypeLinkFn(node, context);
                } break;
            }

            if (linkFn) {
                nodeLinkFns.push(linkFn);
            }
        }

        if (nodeLinkFns.length === 0) {
            // Let the caller know there is nothing special inside this node.
            return null;
        }

        context.finalize();
        return compileUtil.combineLinkFuncs(nodeLinkFns);
    }

    function makeElementLinkFn(element, context) {

        // thi-content is handled as a special case since it's fundamental
        // to the concept of a component element.
        if (element.name == 'thi-content') {
            return function linkThiContent(scope, parentNode, contentLinkFn) {
                if (contentLinkFn) {
                    contentLinkFn(scope, parentNode, undefined);
                }
            }
        }

        var elementDirectives = collectDirectives(element);

        if (elementDirectives.template) {
            // If a template directive is present then it short-circuits all of the
            // default behavior for now, since the compilation of the directive will
            // re-compile this element with the template directive removed.
            return elementDirectives.template.compile(element, context);
        }

        var componentLinkFn;
        if (elementDirectives.component) {
            // If a component directive is present then it short-circuits the child
            // node compilation below, since the child nodes are eaten up by the component,
            // but we'll still apply the attributes from the element that haven't
            // been consumed by directives.
            componentLinkFn = elementDirectives.component.compile(element, context);
        }

        var decoratorLinkFns = elementDirectives.decorators.map(
            function (decoratorDirective) {
                return decoratorDirective.compile(element, context);
            }
        );
        var decoratorPreLinkFns = decoratorLinkFns.map(
            function (linkFnObj) {
                return linkFnObj.pre;
            }
        ).filter(function (fn) { return fn ? true : false; });
        var decoratorPostLinkFns = decoratorLinkFns.map(
            function (linkFnObj) {
                return linkFnObj.post;
            }
        ).filter(function (fn) { return fn ? true : false; });
        decoratorPostLinkFns.reverse();
        var decoratorPreLinkFn = compileUtil.combineLinkFuncs(decoratorPreLinkFns);
        var decoratorPostLinkFn = compileUtil.combineLinkFuncs(decoratorPostLinkFns);

        // Put together the machinery to link in any attributes that are
        // left after all of the directives are processed.
        var attrInterpolateFns = [];
        var attrTemplate = {};
        for (var attrName in element.attribs) {
            if (element.attribs.hasOwnProperty(attrName)) {
                var templateAttrValue = element.attribs[attrName];
                var attrValueLinkFn = interpolate(templateAttrValue, {
                    onlyIfExpression: true
                });

                if (attrValueLinkFn) {
                    attrTemplate[attrName] = new compileUtil.VarRef(
                        'attr' + attrInterpolateFns.length
                    );
                    attrInterpolateFns.push(attrValueLinkFn);
                }
                else {
                    attrTemplate[attrName] = templateAttrValue;
                }
            }
        }
        var attrInterpolateSrc = '';
        var skeletonFnParams = [];
        for (var i = 0; i < attrInterpolateFns.length; i++) {
            // TODO: HTML-escape the value.
            attrInterpolateSrc += 'var attr' + i + ' = attrI' + i + '(scope);\n';
            skeletonFnParams.push('attrI' + i);
        }

        if (componentLinkFn) {
            // Dynamically build a function to apply the attributes, since
            // we know at this point what all of the attribute names will be.
            var applyAttributes;
            if (Object.keys(attrTemplate).length > 0) {
                var applyAttributesSrc = attrInterpolateSrc;
                for (attrName in attrTemplate) {
                    if (attrTemplate.hasOwnProperty(attrName)) {
                        var attrValue = attrTemplate[attrName];
                        if (typeof attrValue === 'object' && attrValue.constructor === compileUtil.VarRef) {
                            applyAttributesSrc += (
                                'attr.' + attrName + ' = ' + attrValue.varName  + ';\n'
                            );
                        }
                        else {
                            applyAttributesSrc += (
                                'attr.' + attrName + ' = ' + JSON.stringify(attrValue)  + ';\n'
                            );
                        }
                    }
                }

                var applyAttributesBuilderSrc = (
                    'return function applyAttributes(scope, attr) {\n' +
                     applyAttributesSrc +
                    '\n; };'
                );
                skeletonFnParams.push(applyAttributesBuilderSrc);
                var applyAttributesBuilderFn = Function.apply(null, skeletonFnParams);
                applyAttributes = applyAttributesBuilderFn.apply(null, attrInterpolateFns);
            }
            else {
                applyAttributes = function applyNoAttributes() {};
            }

            // We need to keep track of which nodes, if any, were added by
            // the component, because we need to apply the decorators and
            // attributes to all of the elements, so we create an artificial
            // element for the component to build itself into.
            // We'll re-use this object for each call to reduce memory pressure.
            var componentRoot = {
                type: 'tag',
                name: 'component-placeholder',
                attribs: {},
                children: []
            };
            return function linkComponentElement(scope, parentNode, contentLinkFn) {
                var children = [];
                var childElements = [];
                var attribs = {};
                componentRoot.children = children;
                componentRoot.attribs = {};
                decoratorPreLinkFn(scope);

                componentLinkFn(scope, componentRoot, contentLinkFn);
                var numChildren = children.length;
                for (var i = 0; i < numChildren; i++) {
                    var child = children[i];
                    if (child.type == 'tag') {
                        childElements.push(child);
                    }
                    // NOTE: We don't bother fixing up the parent/root links
                    // on the children for now, since they don't matter in
                    // most cases and we'd need to do a recursive walk to
                    // fix the root everywhere.
                    parentNode.children.push(child);
                }

                // The component might have created multiple elements and all of them
                // should get the fixed attributes and decorator directives applied,
                // so to preserve the decorator directive contract we handle all
                // of the attributes up front (knowing that decorator directives
                // are only able to see and mutate attributes) and then copy
                // the resulting values verbatim onto all of the child elements
                // that got created as we linked the component template.
                // It is important to do this *after* the component template is
                // linked so that any 'thi-content' elements will be linked between
                // the pre and post link of any decorator directives.

                // Need to apply the attributes *first* so that decorators
                // can optionally mutate them.
                applyAttributes(scope, attribs);
                decoratorPostLinkFn(scope, componentRoot);

                // Now copy the attributes onto all of the child elements.
                var attribNames = Object.keys(attribs);
                var attribCount = attribNames.length;
                var elementCount = childElements.length;
                if (attribCount > 0) {
                    for (i = 0; i < elementCount; i++) {
                        var elementAttribs = childElements[i].attribs;
                        for (var j = 0; j < attribCount; j++) {
                            var key = attribNames[j];
                            elementAttribs[key] = attribs[key];
                        }
                    }
                }
            }
        }
        else {
            // Default handling of child elements via recursive compilation.
            var skeletonTemplate = {
                type: 'tag',
                name: element.name,
                attribs: attrTemplate,
                children: [],
                parent: new compileUtil.VarRef('parent'),
                root: new compileUtil.VarRef('root')
            };

            var skeletonFnSrc = (
                'return function createNode(scope, root, parent) {\n' +
                attrInterpolateSrc +
                '\nreturn (\n' +
                compileUtil.encodeJsonWithVars(skeletonTemplate) +
                '\n); };'
            );
            skeletonFnParams.push(skeletonFnSrc);
            var skeletonFn = Function.apply(null, skeletonFnParams);
            var createNode = skeletonFn.apply(null, attrInterpolateFns);

            var childLinkFn = compileNodeChildren(element, context.makeChildNodeContext());

            return function linkElement(scope, parentNode, contentLinkFn) {
                decoratorPreLinkFn(scope);
                var newNode = createNode(scope, parentNode.root, parentNode);
                if (childLinkFn) {
                    childLinkFn(scope, newNode, contentLinkFn);
                }
                decoratorPostLinkFn(scope, newNode);
                parentNode.children.push(newNode);
            };
        }
    }

    function makeTextLinkFn(node) {
        var templateData = node.data;
        var linkFn = interpolate(templateData, {
            onlyIfExpression: true
        });
        var createNode;
        if (linkFn) {
            createNode = compileUtil.makeObjTemplateFunc(
                {
                    type: 'text',
                    data: new compileUtil.VarRef('data'),
                    parent: new compileUtil.VarRef('parent'),
                    root: new compileUtil.VarRef('root')
                },
                ['root', 'parent', 'data']
            );
            return function linkInterpolatedText(scope, parentNode) {
                // TODO: HTML-escape the data.
                var data = linkFn(scope);
                parentNode.children.push(createNode(parentNode.root, parentNode, data));
            };
        }
        else {
            createNode = compileUtil.makeObjTemplateFunc(
                {
                    type: 'text',
                    data: templateData,
                    parent: new compileUtil.VarRef('parent'),
                    root: new compileUtil.VarRef('root')
                },
                ['root', 'parent']
            );
            return function linkConstantText(scope, parentNode) {
                parentNode.children.push(createNode(parentNode.root, parentNode));
            };
        }
    }

    function makeDoctypeLinkFn(node) {
        var createNode = compileUtil.makeObjTemplateFunc(
            {
                type: 'directive',
                data: node.data,
                parent: new compileUtil.VarRef('parent'),
                root: new compileUtil.VarRef('root')
            },
            ['root', 'parent']
        );
        return function linkDoctype(scope, parentNode) {
            parentNode.children.push(createNode(parentNode.root, parentNode));
        };
    }

    function collectDirectives(node) {
        var templateDirective;
        var componentDirective;
        var decoratorDirectives = [];

        for (var i = 0; i < directives.length; i++) {
            var maybeDirective = directives[i];
            if (maybeDirective.match(node)) {
                switch (maybeDirective.type) {

                    case 'template': {
                        if (templateDirective) {
                            throw new CompileError(
                                'Cannot use ' + templateDirective.selector + ' and ' +
                                    maybeDirective.selector + ' on the same element.'
                            );
                        }
                        else {
                            templateDirective = maybeDirective;
                        }
                    } break;

                    case 'component': {
                        if (componentDirective) {
                            throw new CompileError(
                                'Cannot use ' + componentDirective.selector + ' and ' +
                                    maybeDirective.selector + ' on the same element.'
                            );
                        }
                        else {
                            componentDirective = maybeDirective;
                        }
                    } break;

                    case 'decorator': {
                        decoratorDirectives.push(maybeDirective);
                    } break;

                    default: {
                        throw new Error('Unknown directive type ' + maybeDirective.type);
                    } break;

                }
            }
        }
        return {
            template: templateDirective,
            component: componentDirective,
            decorators: decoratorDirectives
        };
    }

    function makeDefaultElementLinkFn(node) {
        return function defaultElementLink(scope, parentNode) {
            parentNode.children.push({
                type: 'tag',
                name: node.name,
                children: [],
                attribs: {},
                parent: parentNode,
                root: parentNode.root
            });
        }
    }

    function wrapChildLinkFn(fn) {
        return function (scope, node) {
            fn(scope, node.children);
        }
    }

    function wrapTextLinkFn(fn) {
        return function (scope, node) {
            node.children.push(fn(scope));
        }
    }

    return function compile(template, context) {
        if (typeof template === 'string') {
            template = {
                type: 'root',
                children: htmlParser(template),
                root: null
            };
            template.root = template;
        }

        context = context || new CompilerContext();

        var linkFn = compileNodeChildren(template, context);

        var ret = function linkToDom(scope) {
            var nodes = [];
            var root = {
                type: 'root',
                children: nodes,
                root: null
            };
            root.root = root;
            if (linkFn) {
                linkFn(scope, root);
            }
            return nodes;
        };
        ret.appendTo = function linkAndAppend(scope, node, contentLinkFn) {
            if (linkFn) {
                linkFn(scope, node, contentLinkFn);
            }
        };
        return ret;
    };
}

module.exports = Compile;
