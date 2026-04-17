export default [{
  input: {
    server: './src/server.js',
    'utils-docs': './src/utils-docs.js',
    'utils-connection': './src/utils-connection.js',
    callback: './src/callback.js',
    provider: './src/multiplex-provider.js',
    cluster: './src/cluster.js'
  },
  external: id => /^(lib0|yjs|@y|ws|nats|lodash\.debounce|http|y-leveldb)/.test(id),
  output: [{
    dir: 'dist',
    format: 'cjs',
    sourcemap: true,
    entryFileNames: '[name].cjs',
    chunkFileNames: '[name]-[hash].cjs'
  }]
}
]
