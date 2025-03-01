import * as path from "path"
import { Loader, RuleSetRule, Plugin } from "webpack"
import { GraphQLSchema } from "graphql"
import postcss from "postcss"
import autoprefixer from "autoprefixer"
import flexbugs from "postcss-flexbugs-fixes"
import TerserPlugin from "terser-webpack-plugin"
import MiniCssExtractPlugin from "mini-css-extract-plugin"
import OptimizeCssAssetsPlugin from "optimize-css-assets-webpack-plugin"
import ReactRefreshWebpackPlugin from "@pmmmwh/react-refresh-webpack-plugin"
import { getBrowsersList } from "./browserslist"
import semver from "semver"

import { GatsbyWebpackStatsExtractor } from "./gatsby-webpack-stats-extractor"
import { GatsbyWebpackEslintGraphqlSchemaReload } from "./gatsby-webpack-eslint-graphql-schema-reload-plugin"
import {
  GatsbyWebpackVirtualModules,
  VIRTUAL_MODULES_BASE_PATH,
} from "./gatsby-webpack-virtual-modules"

import { builtinPlugins } from "./webpack-plugins"
import { IProgram, Stage } from "../commands/types"
import { eslintConfig } from "./eslint-config"

type LoaderResolver<T = {}> = (options?: T) => Loader

type LoaderOptions = Record<string, any>
type RuleFactory<T = {}> = (options?: T & LoaderOptions) => RuleSetRule

type ContextualRuleFactory<T = {}> = RuleFactory<T> & {
  internal?: RuleFactory<T>
  external?: RuleFactory<T>
}

type PluginFactory = (...args: any) => Plugin

type BuiltinPlugins = typeof builtinPlugins

/**
 * Utils that produce webpack `loader` objects
 */
interface ILoaderUtils {
  json: LoaderResolver
  yaml: LoaderResolver
  null: LoaderResolver
  raw: LoaderResolver

  style: LoaderResolver
  css: LoaderResolver
  postcss: LoaderResolver<{
    browsers?: Array<string>
    overrideBrowserslist?: Array<string>
    plugins?:
      | Array<postcss.Plugin<any>>
      | ((loader: Loader) => Array<postcss.Plugin<any>>)
  }>

  file: LoaderResolver
  url: LoaderResolver
  js: LoaderResolver
  dependencies: LoaderResolver

  miniCssExtract: LoaderResolver
  imports: LoaderResolver
  exports: LoaderResolver

  eslint(schema: GraphQLSchema): Loader
}

interface IModuleThatUseGatsby {
  name: string
  path: string
}

type CssLoaderModuleOption = boolean | Record<string, any> | string

/**
 * Utils that produce webpack rule objects
 */
interface IRuleUtils {
  /**
   * Handles JavaScript compilation via babel
   */
  js: RuleFactory<{ modulesThatUseGatsby?: Array<IModuleThatUseGatsby> }>
  dependencies: RuleFactory<{
    modulesThatUseGatsby?: Array<IModuleThatUseGatsby>
  }>
  yaml: RuleFactory
  fonts: RuleFactory
  images: RuleFactory
  miscAssets: RuleFactory
  media: RuleFactory

  css: ContextualRuleFactory<{
    browsers?: Array<string>
    modules?: CssLoaderModuleOption
  }>
  cssModules: RuleFactory
  postcss: ContextualRuleFactory<{ overrideBrowserOptions: Array<string> }>

  eslint: (schema: GraphQLSchema) => RuleSetRule
}

type PluginUtils = BuiltinPlugins & {
  extractText: PluginFactory
  uglify: PluginFactory
  moment: PluginFactory
  extractStats: PluginFactory
  minifyJs: PluginFactory
  minifyCss: PluginFactory
  fastRefresh: PluginFactory
  eslintGraphqlSchemaReload: PluginFactory
  virtualModules: PluginFactory
}

/**
 * webpack atoms namespace
 */
interface IWebpackUtils {
  loaders: ILoaderUtils

  rules: IRuleUtils

  plugins: PluginUtils
}

/**
 * A factory method that produces an atoms namespace
 */
export const createWebpackUtils = (
  stage: Stage,
  program: IProgram
): IWebpackUtils => {
  const assetRelativeRoot = `static/`
  const vendorRegex = /(node_modules|bower_components)/
  const supportedBrowsers = getBrowsersList(program.directory)

  const PRODUCTION = !stage.includes(`develop`)

  const isSSR = stage.includes(`html`)

  const jsxRuntimeExists = reactHasJsxRuntime()
  const makeExternalOnly = (original: RuleFactory) => (
    options = {}
  ): RuleSetRule => {
    const rule = original(options)
    rule.include = vendorRegex
    return rule
  }

  const makeInternalOnly = (original: RuleFactory) => (
    options = {}
  ): RuleSetRule => {
    const rule = original(options)
    rule.exclude = vendorRegex
    return rule
  }

  let ident = 0

  const loaders: ILoaderUtils = {
    json: (options = {}) => {
      return {
        options,
        loader: require.resolve(`json-loader`),
      }
    },

    yaml: (options = {}) => {
      return {
        options,
        loader: require.resolve(`yaml-loader`),
      }
    },

    null: (options = {}) => {
      return {
        options,
        loader: require.resolve(`null-loader`),
      }
    },

    raw: (options = {}) => {
      return {
        options,
        loader: require.resolve(`raw-loader`),
      }
    },

    style: (options = {}) => {
      return {
        options,
        loader: require.resolve(`style-loader`),
      }
    },

    miniCssExtract: (options = {}) => {
      if (PRODUCTION) {
        // production always uses MiniCssExtractPlugin
        return {
          loader: MiniCssExtractPlugin.loader,
          options,
        }
      } else if (process.env.GATSBY_EXPERIMENTAL_DEV_SSR) {
        // develop with ssr also uses MiniCssExtractPlugin
        return {
          loader: MiniCssExtractPlugin.loader,
          options: {
            ...options,
            // enable hmr for browser bundle, ssr bundle doesn't need it
            hmr: stage === `develop`,
          },
        }
      } else {
        // develop without ssr is using style-loader
        return {
          loader: require.resolve(`style-loader`),
          options,
        }
      }
    },

    css: (options = {}) => {
      return {
        loader: isSSR
          ? require.resolve(`css-loader/locals`)
          : require.resolve(`css-loader`),
        options: {
          sourceMap: !PRODUCTION,
          camelCase: `dashesOnly`,
          // https://github.com/webpack-contrib/css-loader/issues/406
          localIdentName: `[name]--[local]--[hash:base64:5]`,
          ...options,
        },
      }
    },

    postcss: (options = {}) => {
      let {
        plugins,
        overrideBrowserslist = supportedBrowsers,
        ...postcssOpts
      } = options

      return {
        loader: require.resolve(`postcss-loader`),
        options: {
          ident: `postcss-${++ident}`,
          sourceMap: !PRODUCTION,
          plugins: (loader: Loader): Array<postcss.Plugin<any>> => {
            plugins =
              (typeof plugins === `function` ? plugins(loader) : plugins) || []

            const autoprefixerPlugin = autoprefixer({
              overrideBrowserslist,
              flexbox: `no-2009`,
              ...((plugins.find(
                plugin => plugin.postcssPlugin === `autoprefixer`
              ) as autoprefixer.Autoprefixer)?.options ?? {}),
            })

            return [flexbugs, autoprefixerPlugin, ...plugins]
          },
          ...postcssOpts,
        },
      }
    },

    file: (options = {}) => {
      return {
        loader: require.resolve(`file-loader`),
        options: {
          name: `${assetRelativeRoot}[name]-[hash].[ext]`,
          ...options,
        },
      }
    },

    url: (options = {}) => {
      return {
        loader: require.resolve(`url-loader`),
        options: {
          limit: 10000,
          name: `${assetRelativeRoot}[name]-[hash].[ext]`,
          fallback: require.resolve(`file-loader`),
          ...options,
        },
      }
    },

    js: options => {
      return {
        options: {
          stage,
          reactRuntime: jsxRuntimeExists ? `automatic` : `classic`,
          cacheDirectory: path.join(
            program.directory,
            `.cache`,
            `webpack`,
            `babel`
          ),
          ...options,
          rootDir: program.directory,
        },
        loader: require.resolve(`./babel-loader`),
      }
    },

    dependencies: options => {
      return {
        options: {
          cacheDirectory: path.join(
            program.directory,
            `.cache`,
            `webpack`,
            `babel`
          ),
          ...options,
        },
        loader: require.resolve(`babel-loader`),
      }
    },

    eslint: (schema: GraphQLSchema) => {
      const options = eslintConfig(schema, jsxRuntimeExists)

      return {
        options,
        loader: require.resolve(`eslint-loader`),
      }
    },

    imports: (options = {}) => {
      return {
        options,
        loader: require.resolve(`imports-loader`),
      }
    },

    exports: (options = {}) => {
      return {
        options,
        loader: require.resolve(`exports-loader`),
      }
    },
  }

  /**
   * Rules
   */
  const rules = {} as IRuleUtils

  /**
   * JavaScript loader via babel, includes userland code
   * and packages that depend on `gatsby`
   */
  {
    const js = ({
      modulesThatUseGatsby = [],
      ...options
    }: {
      modulesThatUseGatsby?: Array<IModuleThatUseGatsby>
    } = {}): RuleSetRule => {
      return {
        test: /\.(js|mjs|jsx)$/,
        include: (modulePath: string): boolean => {
          // when it's not coming from node_modules we treat it as a source file.
          if (!vendorRegex.test(modulePath)) {
            return true
          }

          // If the module uses Gatsby as a dependency
          // we want to treat it as src so we can extract queries
          return modulesThatUseGatsby.some(module =>
            modulePath.includes(module.path)
          )
        },
        type: `javascript/auto`,
        use: [
          loaders.js({
            ...options,
            configFile: true,
            compact: PRODUCTION,
          }),
        ],
      }
    }
    rules.js = js
  }

  /**
   * Node_modules JavaScript loader via babel
   * Excludes core-js & babel-runtime to speedup babel transpilation
   * Excludes modules that use Gatsby since the `rules.js` already transpiles those
   */
  {
    const dependencies = ({
      modulesThatUseGatsby = [],
    }: {
      modulesThatUseGatsby?: Array<IModuleThatUseGatsby>
    } = {}): RuleSetRule => {
      const jsOptions = {
        babelrc: false,
        configFile: false,
        compact: false,
        presets: [
          [
            require.resolve(`babel-preset-gatsby/dependencies`),
            {
              stage,
            },
          ],
        ],
        // If an error happens in a package, it's possible to be
        // because it was compiled. Thus, we don't want the browser
        // debugger to show the original code. Instead, the code
        // being evaluated would be much more helpful.
        sourceMaps: false,

        cacheIdentifier: JSON.stringify({
          browerslist: supportedBrowsers,
          gatsbyPreset: require(`babel-preset-gatsby/package.json`).version,
        }),
      }

      // TODO REMOVE IN V3
      // a list of vendors we know we shouldn't polyfill (we should have set core-js to entry but we didn't so we have to do this)
      const VENDORS_TO_NOT_POLYFILL = [
        `@babel[\\\\/]runtime`,
        `@mikaelkristiansson[\\\\/]domready`,
        `@reach[\\\\/]router`,
        `babel-preset-gatsby`,
        `core-js`,
        `dom-helpers`,
        `gatsby-legacy-polyfills`,
        `gatsby-link`,
        `gatsby-react-router-scroll`,
        `invariant`,
        `lodash`,
        `mitt`,
        `prop-types`,
        `react-dom`,
        `react`,
        `regenerator-runtime`,
        `scheduler`,
        `scroll-behavior`,
        `shallow-compare`,
        `warning`,
        `webpack`,
      ]
      const doNotPolyfillRegex = new RegExp(
        `[\\\\/]node_modules[\\\\/](${VENDORS_TO_NOT_POLYFILL.join(
          `|`
        )})[\\\\/]`
      )

      return {
        test: /\.(js|mjs)$/,
        exclude: (modulePath: string): boolean => {
          // If dep is user land code, exclude
          if (!vendorRegex.test(modulePath)) {
            return true
          }

          // If dep uses Gatsby, exclude
          if (
            modulesThatUseGatsby.some(module =>
              modulePath.includes(module.path)
            )
          ) {
            return true
          }

          return doNotPolyfillRegex.test(modulePath)
        },
        type: `javascript/auto`,
        use: [loaders.dependencies(jsOptions)],
      }
    }
    rules.dependencies = dependencies
  }

  rules.eslint = (schema: GraphQLSchema): RuleSetRule => {
    return {
      enforce: `pre`,
      test: /\.jsx?$/,
      exclude: (modulePath: string): boolean =>
        modulePath.includes(VIRTUAL_MODULES_BASE_PATH) ||
        vendorRegex.test(modulePath),
      use: [loaders.eslint(schema)],
    }
  }

  rules.yaml = (): RuleSetRule => {
    return {
      test: /\.ya?ml$/,
      use: [loaders.json(), loaders.yaml()],
    }
  }

  /**
   * Font loader
   */
  rules.fonts = (): RuleSetRule => {
    return {
      use: [loaders.url()],
      test: /\.(eot|otf|ttf|woff(2)?)(\?.*)?$/,
    }
  }

  /**
   * Loads image assets, inlines images via a data URI if they are below
   * the size threshold
   */
  rules.images = (): RuleSetRule => {
    return {
      use: [loaders.url()],
      test: /\.(ico|svg|jpg|jpeg|png|gif|webp|avif)(\?.*)?$/,
    }
  }

  /**
   * Loads audio and video and inlines them via a data URI if they are below
   * the size threshold
   */
  rules.media = (): RuleSetRule => {
    return {
      use: [loaders.url()],
      test: /\.(mp4|webm|ogv|wav|mp3|m4a|aac|oga|flac)$/,
    }
  }

  /**
   * Loads assets without inlining
   */
  rules.miscAssets = (): RuleSetRule => {
    return {
      use: [loaders.file()],
      test: /\.pdf$/,
    }
  }

  /**
   * CSS style loader.
   */
  {
    const css: IRuleUtils["css"] = (options = {}): RuleSetRule => {
      const { browsers, ...restOptions } = options
      const use = [
        loaders.css({ ...restOptions, importLoaders: 1 }),
        loaders.postcss({ browsers }),
      ]
      if (!isSSR)
        use.unshift(
          loaders.miniCssExtract({ hmr: !PRODUCTION && !restOptions.modules })
        )

      return {
        use,
        test: /\.css$/,
      }
    }

    /**
     * CSS style loader, _excludes_ node_modules.
     */
    css.internal = makeInternalOnly(css)
    css.external = makeExternalOnly(css)

    const cssModules: IRuleUtils["cssModules"] = (options): RuleSetRule => {
      const rule = css({ ...options, modules: true })
      delete rule.exclude
      rule.test = /\.module\.css$/
      return rule
    }

    rules.css = css
    rules.cssModules = cssModules
  }

  /**
   * PostCSS loader.
   */
  {
    const postcss: ContextualRuleFactory = (options): RuleSetRule => {
      return {
        test: /\.css$/,
        use: [loaders.css({ importLoaders: 1 }), loaders.postcss(options)],
      }
    }

    /**
     * PostCSS loader, _excludes_ node_modules.
     */
    postcss.internal = makeInternalOnly(postcss)
    postcss.external = makeExternalOnly(postcss)
    rules.postcss = postcss
  }
  /**
   * cast rules to IRuleUtils
   */
  /**
   * Plugins
   */
  const plugins = { ...builtinPlugins } as PluginUtils

  plugins.minifyJs = ({
    terserOptions,
    ...options
  }: { terserOptions?: TerserPlugin.TerserPluginOptions } = {}): Plugin =>
    new TerserPlugin({
      // TODO add proper cache keys
      cache: path.join(program.directory, `.cache`, `webpack`, `terser`),
      exclude: /\.min\.js/,
      sourceMap: true,
      terserOptions: {
        ie8: false,
        mangle: {
          safari10: true,
        },
        parse: {
          ecma: 8,
        },
        compress: {
          ecma: 5,
        },
        output: {
          ecma: 5,
        },
        ...terserOptions,
      },
      ...options,
    })

  plugins.minifyCss = (
    options = {
      cssProcessorPluginOptions: {
        preset: [
          `default`,
          {
            svgo: {
              full: true,
              plugins: [
                {
                  // potentially destructive plugins removed - see https://github.com/gatsbyjs/gatsby/issues/15629
                  // convertShapeToPath: true,
                  // removeViewBox: true,
                  removeUselessDefs: true,
                  addAttributesToSVGElement: true,
                  addClassesToSVGElement: true,
                  cleanupAttrs: true,
                  cleanupEnableBackground: true,
                  cleanupIDs: true,
                  cleanupListOfValues: true,
                  cleanupNumericValues: true,
                  collapseGroups: true,
                  convertColors: true,
                  convertPathData: true,
                  convertStyleToAttrs: true,
                  convertTransform: true,
                  inlineStyles: true,
                  mergePaths: true,
                  minifyStyles: true,
                  moveElemsAttrsToGroup: true,
                  moveGroupAttrsToElems: true,
                  prefixIds: true,
                  removeAttributesBySelector: true,
                  removeAttrs: true,
                  removeComments: true,
                  removeDesc: true,
                  removeDimensions: true,
                  removeDoctype: true,
                  removeEditorsNSData: true,
                  removeElementsByAttr: true,
                  removeEmptyAttrs: true,
                  removeEmptyContainers: true,
                  removeEmptyText: true,
                  removeHiddenElems: true,
                  removeMetadata: true,
                  removeNonInheritableGroupAttrs: true,
                  removeOffCanvasPaths: true,
                  removeRasterImages: true,
                  removeScriptElement: true,
                  removeStyleElement: true,
                  removeTitle: true,
                  removeUnknownsAndDefaults: true,
                  removeUnusedNS: true,
                  removeUselessStrokeAndFill: true,
                  removeXMLNS: true,
                  removeXMLProcInst: true,
                  reusePaths: true,
                  sortAttrs: true,
                },
              ],
            },
          },
        ],
      },
    }
  ): OptimizeCssAssetsPlugin => new OptimizeCssAssetsPlugin(options)

  plugins.fastRefresh = (): Plugin =>
    new ReactRefreshWebpackPlugin({
      overlay: false,
    })

  plugins.extractText = (options: any): Plugin =>
    new MiniCssExtractPlugin({
      ...options,
    })

  plugins.moment = (): Plugin => plugins.ignore(/^\.\/locale$/, /moment$/)

  plugins.extractStats = (): GatsbyWebpackStatsExtractor =>
    new GatsbyWebpackStatsExtractor()

  plugins.eslintGraphqlSchemaReload = (): GatsbyWebpackEslintGraphqlSchemaReload =>
    new GatsbyWebpackEslintGraphqlSchemaReload()

  plugins.virtualModules = (): GatsbyWebpackVirtualModules =>
    new GatsbyWebpackVirtualModules()

  return {
    loaders,
    rules,
    plugins,
  }
}

export function reactHasJsxRuntime(): boolean {
  // We've got some complains about the ecosystem not being ready for automatic so we disable it by default.
  // People can use a custom babelrc file to support it
  // try {
  //   // React is shipping a new jsx runtime that is to be used with
  //   // an option on @babel/preset-react called `runtime: automatic`
  //   // Not every version of React has this jsx-runtime yet. Eventually,
  //   // it will be backported to older versions of react and this check
  //   // will become unnecessary.
  //   // for now we also do the semver check until react 17 is more widely used
  //   // const react = require(`react/package.json`)
  //   // return (
  //   //   !!require.resolve(`react/jsx-runtime.js`) &&
  //   //   semver.major(react.version) >= 17
  //   // )
  // } catch (e) {
  //   // If the require.resolve throws, that means this version of React
  //   // does not support the jsx runtime.
  // }

  return false
}
