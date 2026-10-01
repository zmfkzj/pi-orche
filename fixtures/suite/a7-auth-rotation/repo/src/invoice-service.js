export class InvoiceService {
  constructor(client) {
    this.client = client;
  }

  async listForAccounts(accountIds) {
    const batches = await Promise.all(accountIds.map(id => this.client.get('/accounts/' + encodeURIComponent(id) + '/invoices')));
    return batches.flat();
  }
}
