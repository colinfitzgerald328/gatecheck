export function boot() {
  if (ldClient.boolVariation('dark-mode', false)) document.body.classList.add('dark');
  mountApp();
}
