process.on('warning', (warning) => {
  if (warning.message?.includes('SSL modes') && warning.message?.includes('pg-connection-string')) return;
  console.warn(warning);
});
