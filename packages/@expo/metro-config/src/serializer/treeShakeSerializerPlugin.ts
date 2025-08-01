/**
 * Copyright © 2024 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { type NodePath, traverse, types } from '@babel/core';
import generate from '@babel/generator';
import assert from 'assert';
import { AsyncDependencyType, MixedOutput, Module, ReadOnlyGraph } from 'metro';
import { SerializerConfigT } from 'metro-config';

import { ExpoSerializerOptions } from './fork/baseJSBundle';
import { isExpoJsOutput } from './jsOutput';
import { sortDependencies } from './reconcileTransformSerializerPlugin';
import { hasSideEffectWithDebugTrace } from './sideEffects';
import {
  DependencyData,
  MutableInternalDependency,
} from '../transform-worker/collect-dependencies';
import { collectDependenciesForShaking } from '../transform-worker/metro-transform-worker';

const debug = require('debug')('expo:treeshake') as typeof console.log;
const isDebugEnabled = require('debug').enabled('expo:treeshake');

const OPTIMIZE_GRAPH = true;

type Serializer = NonNullable<SerializerConfigT['customSerializer']>;

type SerializerParameters = Parameters<Serializer>;

type AdvancedMixedOutput = {
  readonly data: {
    ast?: types.File;
    code: string;
    hasCjsExports?: boolean;
  };
  readonly type: string;
};

export function isModuleEmptyFor(ast?: types.File) {
  if (!ast?.program.body.length) {
    return true;
  }

  let isEmptyOrCommentsAndUseStrict = true; // Assume true until proven otherwise

  traverse(ast, {
    enter(path) {
      const { node } = path;
      // If it's not a Directive, ExpressionStatement, or empty body,
      // it means we have actual code
      if (
        node.type !== 'Directive' &&
        node.type !== 'ExpressionStatement' &&
        !(node.type === 'Program' && node.body.length === 0)
      ) {
        isEmptyOrCommentsAndUseStrict = false;
        path.stop(); // No need to traverse further
      }
    },
    // If we encounter any non-comment nodes, it's not empty
    noScope: true,
  });

  return isEmptyOrCommentsAndUseStrict;
}

function isEmptyModule(value: Module<MixedOutput>): boolean {
  return value.output.every((outputItem) => {
    return isModuleEmptyFor(accessAst(outputItem));
  });
}

// Collect a list of exports that are not used within the module.
function getExportsThatAreNotUsedInModule(ast: types.File) {
  const exportedIdentifiers = new Set<string>();
  const usedIdentifiers = new Set<string>();
  const unusedExports: string[] = [];

  // First pass: collect all export identifiers
  traverse(ast, {
    ExportNamedDeclaration(path) {
      const { declaration, specifiers } = path.node;
      if (declaration) {
        if ('declarations' in declaration && declaration.declarations) {
          declaration.declarations.forEach((decl) => {
            if (types.isIdentifier(decl.id)) {
              exportedIdentifiers.add(decl.id.name);
            }
          });
        } else if ('id' in declaration && types.isIdentifier(declaration.id)) {
          exportedIdentifiers.add(declaration.id.name);
        }
      }
      specifiers.forEach((spec) => {
        if (types.isIdentifier(spec.exported)) {
          exportedIdentifiers.add(spec.exported.name);
        }
      });
    },

    ExportDefaultDeclaration(path) {
      // Default exports need to be handled separately
      // Assuming the default export is a function or class declaration:
      if ('id' in path.node.declaration && types.isIdentifier(path.node.declaration.id)) {
        exportedIdentifiers.add(path.node.declaration.id.name);
      }
    },
  });

  // Second pass: find all used identifiers
  traverse(ast, {
    Identifier(path) {
      if (path.isReferencedIdentifier()) {
        // console.log('referenced:', path.node.name);
        usedIdentifiers.add(path.node.name);
      }
    },
  });

  // Determine which exports are unused
  exportedIdentifiers.forEach((exported) => {
    if (!usedIdentifiers.has(exported)) {
      unusedExports.push(exported);
    }
  });

  return unusedExports;
}

function populateModuleWithImportUsage(value: Module<AdvancedMixedOutput>) {
  for (const index in value.output) {
    const outputItem = value.output[index];

    if (!isExpoJsOutput(outputItem)) {
      continue;
    }
    const ast = outputItem.data.ast;

    // This should be cached by the transform worker for use here to ensure close to consistent
    // results between the tree-shake and the final transform.
    const reconcile = outputItem.data.reconcile;

    assert(ast, 'ast must be defined.');
    assert(reconcile, 'reconcile settings are required in the module graph for post transform.');

    const deps = collectDependenciesForShaking(
      // @ts-expect-error
      ast,
      reconcile.collectDependenciesOptions
    ).dependencies;

    // @ts-expect-error: Mutating the value in place.
    value.dependencies =
      //
      sortDependencies(deps, value.dependencies);
  }
}

function markUnused(path: NodePath) {
  // Format path as code
  if (isDebugEnabled) {
    debug('Delete AST:\n' + generate(path.node).code);
  }
  path.remove();
}

export async function treeShakeSerializer(
  entryPoint: string,
  preModules: readonly Module<MixedOutput>[],
  graph: ReadOnlyGraph,
  options: ExpoSerializerOptions
): Promise<SerializerParameters> {
  if (!options.serializerOptions?.usedExports) {
    return [entryPoint, preModules, graph, options];
  }

  if (!OPTIMIZE_GRAPH) {
    // Useful for testing the transform reconciler...
    return [entryPoint, preModules, graph, options];
  }

  const starExportsForModules = new Map<
    string,
    { exportNames: string[]; isStatic: boolean; hasUnresolvableStarExport: boolean }
  >();

  for (const value of graph.dependencies.values()) {
    // TODO: Move this to the transformer and combine with collect dependencies.
    getExportsForModule(value);
  }

  const beforeList = [...graph.dependencies.keys()];

  // Tree shake the graph.
  optimizePaths([entryPoint]);

  if (isDebugEnabled) {
    // Debug pass: Print all orphaned modules.
    for (const [, value] of graph.dependencies.entries()) {
      if (value.inverseDependencies.size !== 0) {
        let hasNormalNode = false;
        for (const dep of value.inverseDependencies) {
          if (!graph.dependencies.has(dep)) {
            debug(
              `[ISSUE]: Dependency: ${value.path}, has inverse relation to missing node: ${dep}`
            );
          } else {
            hasNormalNode = true;
          }
        }
        if (!hasNormalNode) {
          debug(`[ERROR]: All inverse dependencies are missing for: ${value.path}`);
        }
      }
    }

    const afterList = [...graph.dependencies.keys()];

    // Print the removed modules:
    const removedModules = beforeList.filter((value) => !afterList.includes(value));

    if (removedModules.length) {
      debug('Modules that were fully removed:');
      debug(removedModules.sort().join('\n'));
    }
  }

  return [entryPoint, preModules, graph, options];

  function getExportsForModule(
    value: Module<AdvancedMixedOutput>,
    checkedModules: Set<string> = new Set()
  ): { exportNames: string[]; isStatic: boolean; hasUnresolvableStarExport: boolean } {
    if (starExportsForModules.has(value.path)) {
      return starExportsForModules.get(value.path)!;
    }
    if (checkedModules.has(value.path)) {
      // TODO: Handle circular dependencies.
      throw new Error('Circular dependency detected while tree-shaking: ' + value.path);
      // return {
      //   exportNames: [],
      //   isStatic: true,
      //   hasUnresolvableStarExport: true,
      // };
    }
    checkedModules.add(value.path);

    function getDepForImportId(importModuleId: string) {
      // The hash key for the dependency instance in the module.
      const targetHashId = getDependencyHashIdForImportModuleId(value, importModuleId);
      // If the dependency was already removed, then we don't need to do anything.

      const importInstance = value.dependencies.get(targetHashId)!;

      const graphEntryForTargetImport = graph.dependencies.get(importInstance.absolutePath);
      // Should never happen but we're playing with fire here.
      if (!graphEntryForTargetImport) {
        throw new Error(
          `Failed to find graph key for re-export "${importModuleId}" while optimizing ${
            value.path
          }. Options: ${[...value.dependencies.values()].map((v) => v.data.name).join(', ')}`
        );
      }
      return graphEntryForTargetImport;
    }

    const exportNames: string[] = [];
    // Indicates that the module does not have any dynamic exports, e.g. `module.exports`, `Object.assign(exports)`, etc.
    let isStatic = true;
    let hasUnresolvableStarExport = false;

    for (const index in value.output) {
      const outputItem = value.output[index];
      if (!isExpoJsOutput(outputItem)) {
        continue;
      }

      const ast = outputItem.data.ast;
      if (!ast) continue;

      // Detect if the module is static...
      if (outputItem.data.hasCjsExports) {
        isStatic = false;
      }

      traverse(ast, {
        // export * from 'a'
        // NOTE: This only runs on normal `* from` syntax as `* as X from` is converted to an import.
        ExportAllDeclaration(path) {
          if (path.node.source) {
            // Get module for import ID:
            const nextModule = getDepForImportId(path.node.source.value);
            const exportResults = getExportsForModule(nextModule, checkedModules);
            // console.log('exportResults', exportResults);

            if (exportResults.isStatic && !exportResults.hasUnresolvableStarExport) {
              // Collect all exports from the module.
              // exportNames.push(...exportResults.exportNames);
              // Convert the export all to named exports.
              // ```
              // export * from 'a';
              // ```
              // becomes
              // ```
              // export { a, b, c } from 'a';
              // ```
              // NOTE: It's important we only use one statement so we don't skew the multi-dep tracking from collect dependencies.
              path.replaceWithMultiple([
                // @ts-expect-error: missing type
                types.ExportNamedDeclaration(
                  null,
                  exportResults.exportNames.map((exportName) =>
                    types.exportSpecifier(
                      types.identifier(exportName),
                      types.identifier(exportName)
                    )
                  ),
                  types.stringLiteral(path.node.source.value)
                ),
              ]);

              // TODO: Update deps
              populateModuleWithImportUsage(value);
            } else {
              debug('Cannot resolve star export:', nextModule.path);
              hasUnresolvableStarExport = true;
            }

            // Collect all exports from the module.

            // If list of exports does not contain any CJS, then re-write the export all as named exports.
          }
        },
      });

      // Collect export names
      traverse(ast, {
        ExportNamedDeclaration(path) {
          const { declaration, specifiers } = path.node;
          if (declaration) {
            if ('declarations' in declaration && declaration.declarations) {
              declaration.declarations.forEach((decl) => {
                if (types.isIdentifier(decl.id)) {
                  exportNames.push(decl.id.name);
                }
              });
            } else if ('id' in declaration && types.isIdentifier(declaration.id)) {
              exportNames.push(declaration.id.name);
            }
          }
          specifiers.forEach((spec) => {
            if (types.isIdentifier(spec.exported)) {
              exportNames.push(spec.exported.name);
            }
          });
        },

        ExportDefaultDeclaration(path) {
          // Default exports need to be handled separately
          // Assuming the default export is a function or class declaration
          if ('id' in path.node.declaration && types.isIdentifier(path.node.declaration.id)) {
            exportNames.push(path.node.declaration.id.name);
          }

          // If it's an expression, then it's a static export.
          isStatic = true;
        },
      });
    }

    const starExport = {
      exportNames,
      isStatic,
      hasUnresolvableStarExport,
    };
    starExportsForModules.set(value.path, starExport);

    return starExport;
  }

  function disposeOfGraphNode(nodePath: string) {
    const node = graph.dependencies.get(nodePath);
    if (!node) return;
    // Recursively remove all dependencies.
    for (const dep of node.dependencies.values()) {
      const child = graph.dependencies.get(dep.absolutePath);
      if (!child) continue;

      // TODO: Might need to clean up the multi-dep tracking, e.g. importInstance.data.data.locs.pop();

      // Remove inverse dependency on the node we're about to delete.
      child.inverseDependencies.delete(nodePath);
      // If the child has no more dependencies, then remove it from the graph too.
      if (child.inverseDependencies.size === 0) {
        disposeOfGraphNode(dep.absolutePath);
      }
    }

    // @ts-expect-error
    graph.dependencies.delete(nodePath);
  }

  function getDependencyHashIdForImportModuleId(
    graphModule: Module<MixedOutput>,
    importModuleId: string
  ) {
    // Unlink the module in the graph

    // The hash key for the dependency instance in the module.
    const depId = [...graphModule.dependencies.entries()].find(([key, dep]) => {
      return dep.data.name === importModuleId;
    })?.[0];

    // // Should never happen but we're playing with fire here.
    if (!depId) {
      throw new Error(
        `Failed to find graph key for import "${importModuleId}" from "${importModuleId}" while optimizing ${
          graphModule.path
        }. Options: ${[...graphModule.dependencies.values()].map((v) => v.data.name).join(', ')}`
      );
    }
    return depId;
  }
  function disconnectGraphNode(
    graphModule: Module<MixedOutput>,
    importModuleId: string,
    {
      isSideEffectyImport,
      bailOnDuplicateDefaultExport,
    }: { isSideEffectyImport?: boolean; bailOnDuplicateDefaultExport?: boolean } = {}
  ): { path: string; removed: boolean } {
    // Unlink the module in the graph
    // The hash key for the dependency instance in the module.
    const targetHashId = getDependencyHashIdForImportModuleId(graphModule, importModuleId);
    // If the dependency was already removed, then we don't need to do anything.

    const importInstance = graphModule.dependencies.get(targetHashId)!;

    const graphEntryForTargetImport = graph.dependencies.get(importInstance.absolutePath);
    // Should never happen but we're playing with fire here.
    if (!graphEntryForTargetImport) {
      throw new Error(
        `Failed to find graph key for re-export "${importModuleId}" while optimizing ${
          graphModule.path
        }. Options: ${[...graphModule.dependencies.values()].map((v) => v.data.name).join(', ')}`
      );
    }

    //
    if (graphEntryForTargetImport.path.match(/\.(s?css|sass)$/)) {
      debug('Skip graph unlinking for CSS:');
      debug('- Origin module:', graphModule.path);
      debug('- Module ID:', importModuleId);
      // Skip CSS imports.
      return { path: importInstance.absolutePath, removed: false };
    }

    if (
      bailOnDuplicateDefaultExport &&
      // @ts-expect-error: exportNames is added by babel
      importInstance.data.data.exportNames?.includes('default')
    ) {
      debug('Skip graph unlinking for duplicate default export:');
      debug('- Origin module:', graphModule.path);
      debug('- Module ID:', importModuleId);
      // Skip CSS imports.
      return { path: importInstance.absolutePath, removed: false };
    }

    const [authorMarkedSideEffect, trace] = hasSideEffectWithDebugTrace(
      options,
      graph,
      graphEntryForTargetImport
    );

    // If the package.json chain explicitly marks the module as side-effect-free, then we can remove imports that have no specifiers.
    const isFx = authorMarkedSideEffect ?? isSideEffectyImport;

    if (isDebugEnabled && isSideEffectyImport) {
      if (authorMarkedSideEffect == null) {
        // This is for debugging modules that should be marked as side-effects but are not.
        if (!trace.length) {
          debug('----');
          debug(
            'Found side-effecty import (no specifiers) that is not marked as a side effect in the package.json:'
          );
          debug('- Origin module:', graphModule.path);
          debug('- Module ID (needs marking):', importModuleId);
          // debug('- FX trace:', trace.join(' > '));
          debug('----');
        }
      } else if (!isFx) {
        debug(
          'Removing side-effecty import (package.json indicates it is not a side-effect):',
          importModuleId,
          'from:',
          graphModule.path
        );
      }
    }

    // let trace: string[] = [];

    if (
      // Don't remove the module if it has side effects.
      !isFx ||
      // Unless it's an empty module.
      isEmptyModule(graphEntryForTargetImport)
    ) {
      // TODO: Get the exact instance of the import. This help with more readable errors when import was not counted.
      const importData = importInstance.data.data as MutableInternalDependency;
      assert(
        'imports' in importData,
        'Expo InternalDependency type expected, but `imports` key is missing.'
      );
      importData.imports -= 1;

      if (importData.imports <= 0) {
        // Remove dependency from this module so it doesn't appear in the dependency map.
        graphModule.dependencies.delete(targetHashId);

        // Remove inverse link to this dependency
        graphEntryForTargetImport.inverseDependencies.delete(graphModule.path);

        if (graphEntryForTargetImport.inverseDependencies.size === 0) {
          debug('Unlink module from graph:', importInstance.absolutePath);
          // Remove the dependency from the graph as no other modules are using it anymore.
          disposeOfGraphNode(importInstance.absolutePath);
        }
      }

      // Mark the module as removed so we know to traverse again.
      return { path: importInstance.absolutePath, removed: true };
    } else {
      if (isFx) {
        debug('Skip graph unlinking due to side-effect:');
        debug('- Origin module:', graphModule.path);
        debug('- Module ID:', importModuleId);
        debug('- FX trace:', trace.join(' > '));
      } else {
        debug('Skip graph unlinking:', {
          depId: targetHashId,
          isFx,
        });
      }
    }

    return { path: importInstance.absolutePath, removed: false };
  }

  function removeUnusedExports(value: Module<MixedOutput>, depth: number = 0): string[] {
    if (!accessAst(value.output[0]) || !value.inverseDependencies.size) {
      return [];
    }
    if (depth > 5) {
      debug('Max export removal depth reached for:', value.path);
      return [];
    }
    const dirtyImports: string[] = [];
    let needsImportReindex = false;
    let shouldRecurseUnusedExports = false;

    const inverseDeps = [
      // @ts-expect-error: Type 'Iterator<string, any, undefined>' must have a '[Symbol.iterator]()' method that returns an iterator.
      ...value.inverseDependencies.values(),
    ].map((id) => {
      return graph.dependencies.get(id);
    });

    const isExportUsed = (importName: string) => {
      return inverseDeps.some((dep) => {
        const isModule = dep?.output.some((outputItem: AdvancedMixedOutput) => {
          return outputItem.type === 'js/module';
        });

        if (!isModule) {
          return false;
        }

        return [
          // @ts-expect-error: Type 'Iterator<string, any, undefined>' must have a '[Symbol.iterator]()' method that returns an iterator.
          ...dep?.dependencies.values(),
        ].some(
          (importItem: {
            absolutePath: string;
            asyncType: AsyncDependencyType;
            data: { data: DependencyData };
          }) => {
            if (importItem.absolutePath !== value.path) {
              return false;
            }

            // If the import is async or weak then we can't tree shake it.
            if (importItem.asyncType) {
              // if (['async', 'prefetch', 'weak'].includes(importItem.asyncType)) {
              return true;
            }

            if (!importItem.data.data.exportNames) {
              throw new Error('Missing export names for: ' + importItem.absolutePath);
            }

            const isUsed = importItem.data.data.exportNames.some(
              (exportName) => exportName === '*' || exportName === importName
            );
            return isUsed;
          }
        );
      });
    };

    for (const index in value.output) {
      const outputItem = value.output[index];
      if (!isExpoJsOutput(outputItem)) {
        continue;
      }

      const ast = outputItem.data.ast;
      if (!ast) {
        throw new Error('AST missing for module: ' + value.path);
      }

      // Collect a list of exports that are not used within the module.
      const possibleUnusedExports = getExportsThatAreNotUsedInModule(ast);

      // Traverse exports and mark them as used or unused based on if inverse dependencies are importing them.
      traverse(ast, {
        ExportDefaultDeclaration(path) {
          if (possibleUnusedExports.includes('default') && !isExportUsed('default')) {
            // TODO: Update source maps
            markUnused(path);
          }
        },

        ExportNamedDeclaration(path) {
          const importModuleId = path.node.source?.value;

          // Remove specifiers, e.g. `export { Foo, Bar as Bax }`
          if (types.isExportNamedDeclaration(path.node)) {
            for (let i = 0; i < path.node.specifiers.length; i++) {
              const specifier = path.node.specifiers[i];
              if (
                types.isExportSpecifier(specifier) &&
                types.isIdentifier(specifier.local) &&
                types.isIdentifier(specifier.exported) &&
                possibleUnusedExports.includes(specifier.exported.name) &&
                !isExportUsed(specifier.exported.name)
              ) {
                // Remove specifier
                path.node.specifiers.splice(i, 1);

                needsImportReindex = true;
                i--;
              }
            }
          }

          // Remove the entire node if the export has been completely removed.

          const declaration = path.node.declaration;

          if (types.isVariableDeclaration(declaration)) {
            declaration.declarations = declaration.declarations.filter((decl) => {
              if (decl.id.type === 'Identifier') {
                if (possibleUnusedExports.includes(decl.id.name) && !isExportUsed(decl.id.name)) {
                  // TODO: Update source maps
                  debug(
                    `mark remove (type: var, depth: ${depth}):`,
                    decl.id.name,
                    'from:',
                    value.path
                  );

                  // Account for variables, and classes which may contain references to other exports.
                  shouldRecurseUnusedExports = true;
                  return false; // Remove this declaration
                }
              }
              return true; // Keep this declaration
            });

            // If all declarations were removed, remove the entire path
            if (declaration.declarations.length === 0) {
              markUnused(path);
            }
          } else if (declaration && 'id' in declaration && types.isIdentifier(declaration.id)) {
            // function, class, etc.
            if (
              possibleUnusedExports.includes(declaration.id.name) &&
              !isExportUsed(declaration.id.name)
            ) {
              debug(
                `mark remove (type: function, depth: ${depth}):`,
                declaration.id.name,
                'from:',
                value.path
              );
              // TODO: Update source maps
              markUnused(path);

              // Code inside of an unused export may affect other exports in the module.
              // e.g.
              //
              // export const a = () => {}
              //
              // // Removed `b` -> recurse for `a`
              // export const b = () => { a() };
              //
              shouldRecurseUnusedExports = true;
            }
          }

          // If export from import then check if we can remove the import.
          if (importModuleId) {
            if (path.node.specifiers.length === 0) {
              const removeRequest = disconnectGraphNode(value, importModuleId, {
                // Due to a quirk in how we've added tree shaking, export-all is expanded and could overlap with existing exports in the same module.
                // If we find that the existing export has a default export then we should skip removing the node entirely.
                bailOnDuplicateDefaultExport: true,
              });
              if (removeRequest.removed) {
                dirtyImports.push(removeRequest.path);
                // TODO: Update source maps
                markUnused(path);
              }
            }
          }
        },
      });
    }

    if (needsImportReindex) {
      // TODO: Do this better with a tracked removal of the import rather than a full reparse.
      populateModuleWithImportUsage(value);
    }

    if (shouldRecurseUnusedExports) {
      return unique(removeUnusedExports(value, depth + 1).concat(dirtyImports));
    }

    return unique(dirtyImports);
  }

  function removeUnusedImportsFromModule(
    value: Module<MixedOutput>,
    ast: types.Node | undefined
  ): string[] {
    // json, asset, script, etc.
    if (!ast) {
      return [];
    }
    // Traverse imports and remove unused imports.

    // Keep track of all the imported identifiers
    const importedIdentifiers = new Set<string>();

    // Keep track of all used identifiers
    const usedIdentifiers = new Set<string>();

    const importDecs: NodePath<types.ImportDeclaration>[] = [];

    traverse(ast, {
      ImportSpecifier(path) {
        if (
          // Support `import { foo as bar } from './foo'`
          path.node.local.name != null
        ) {
          importedIdentifiers.add(path.node.local.name);
        } else if (
          // Support `import { foo } from './foo'`
          types.isIdentifier(path.node.imported) &&
          path.node.imported.name != null
        ) {
          importedIdentifiers.add(path.node.imported.name);
        } else {
          throw new Error('Unknown import specifier: ' + path.node.type);
        }
      },
      ImportDefaultSpecifier(path) {
        importedIdentifiers.add(path.node.local.name);
      },
      ImportNamespaceSpecifier(path) {
        importedIdentifiers.add(path.node.local.name);
      },
      Identifier(path) {
        // Make sure this identifier isn't coming from an import specifier
        if (!path.scope.bindingIdentifierEquals(path.node.name, path.node)) {
          usedIdentifiers.add(path.node.name);
        }
      },
      ImportDeclaration(path) {
        // Mark the path with some metadata indicating that it originally had `n` specifiers.
        // This is used to determine if the import was side-effecty.

        // NOTE: This could be a problem if the AST is re-parsed.
        // TODO: This doesn't account for `import {} from './foo'`
        path.opts.originalSpecifiers ??= path.node.specifiers.length;
        importDecs.push(path);
      },
    });

    const dirtyImports: string[] = [];
    if (!importDecs.length) {
      return dirtyImports;
    }

    // Determine unused identifiers by subtracting the used from the imported
    const unusedImports = [...importedIdentifiers].filter(
      (identifier) => !usedIdentifiers.has(identifier)
    );

    // Remove the unused imports from the AST
    importDecs.forEach((path) => {
      const originalSize = path.node.specifiers.length;
      const absoluteOriginalSize = path.opts.originalSpecifiers ?? originalSize;

      path.node.specifiers = path.node.specifiers.filter((specifier) => {
        if (
          specifier.type === 'ImportDefaultSpecifier' ||
          specifier.type === 'ImportNamespaceSpecifier'
        ) {
          return !unusedImports.includes(specifier.local.name);
        } else if (types.isIdentifier(specifier.imported)) {
          return !unusedImports.includes(specifier.imported.name);
        }
        return false;
      });

      const importModuleId = path.node.source.value;

      if (originalSize !== path.node.specifiers.length) {
        // The hash key for the dependency instance in the module.
        const targetHashId = getDependencyHashIdForImportModuleId(value, importModuleId);
        const importInstance = value.dependencies.get(targetHashId);
        if (importInstance) {
          dirtyImports.push(importInstance.absolutePath);
        }
      }

      // If no specifiers are left after filtering, remove the whole import declaration
      // e.g. `import './unused'` or `import {} from './unused'` -> remove.
      if (path.node.specifiers.length === 0) {
        const removeRequest = disconnectGraphNode(value, importModuleId, {
          isSideEffectyImport: absoluteOriginalSize === 0 ? true : undefined,
        });
        if (removeRequest.removed) {
          debug('Disconnect import:', importModuleId, 'from:', value.path);
          // TODO: Update source maps
          // Delete the import AST
          markUnused(path);
          dirtyImports.push(removeRequest.path);
        }
      }
    });

    return unique(dirtyImports);
  }

  function removeUnusedImports(value: Module<MixedOutput>): string[] {
    if (!value.dependencies.size) {
      return [];
    }
    const dirtyImports = value.output
      .map((outputItem) => {
        return removeUnusedImportsFromModule(value, accessAst(outputItem));
      })
      .flat();

    if (dirtyImports.length) {
      // TODO: Do this better with a tracked removal of the import rather than a full reparse.
      populateModuleWithImportUsage(value);
    }
    return dirtyImports;
  }

  function unique<T extends any[]>(array: T): T {
    return Array.from(new Set(array)) as T;
  }

  function optimizePaths(paths: string[]) {
    const checked = new Set<string>();

    function markDirty(...paths: string[]) {
      paths.forEach((path) => {
        checked.delete(path);
        paths.push(path);
      });
    }

    // This pass will annotate the AST with the used and unused exports.
    while (paths.length) {
      const absolutePath = paths.pop();
      if (absolutePath == null) continue;
      if (checked.has(absolutePath)) {
        // debug('Bail:', absolutePath);
        continue;
      }
      const dep = graph.dependencies.get(absolutePath);
      if (!dep) continue;

      checked.add(absolutePath);

      markDirty(
        // Order is important (not sure why though)
        ...removeUnusedExports(dep),
        // Remove imports after exports
        ...removeUnusedImports(dep)
      );

      // Optimize all deps without marking as dirty to prevent
      // circular dependencies from creating infinite loops.
      dep.dependencies.forEach((dep) => {
        paths.push(dep.absolutePath);
      });
    }

    if (isDebugEnabled) {
      // Print if any dependencies weren't checked (this shouldn't happen)
      const unchecked = [...graph.dependencies.entries()]
        .filter(([key, value]) => !checked.has(key) && accessAst(value.output[0]))
        .map(([key]) => key);
      if (unchecked.length) {
        debug('[ISSUE]: Unchecked modules:', unchecked);
      }
    }
  }
}

function accessAst(output: AdvancedMixedOutput): types.File | undefined {
  return output.data.ast;
}
