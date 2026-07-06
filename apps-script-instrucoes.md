# Aprovar mudanças → gravar na planilha (Google Apps Script)

O site é estático e só **lê** a planilha. Para o botão **"Aprovar mudanças"** gravar
de volta, você publica um pequeno script dentro da própria planilha. **Não é preciso
compartilhar login/senha com ninguém** — a autorização é feita por você, uma única
vez, no seu navegador.

## Passo a passo (±3 minutos)

1. Abra a planilha do estoque no Google Sheets (logado na sua conta).
2. Menu **Extensões → Apps Script**.
3. Apague o conteúdo do editor e cole o código da seção abaixo. Salve (Ctrl+S).
4. Clique em **Implantar → Nova implantação**.
5. Em "Selecionar tipo" (ícone de engrenagem), escolha **App da Web**.
6. Configure:
   - **Executar como:** Eu (sua conta)
   - **Quem pode acessar:** Qualquer pessoa
7. Clique em **Implantar**. O Google vai pedir autorização — aceite
   (pode aparecer "app não verificado": clique em *Avançado → Acessar... (não seguro)*;
   é o seu próprio script).
8. Copie a **URL do app da Web** (termina em `/exec`).
9. Abra `Estoque MKT.dc.html` e cole a URL na constante `SCRIPT_URL`:

   ```js
   SCRIPT_URL = "https://script.google.com/macros/s/SEU_ID_AQUI/exec";
   ```

Pronto. O botão "Aprovar mudanças" passa a atualizar a coluna **TOTAL UN** e a
carimbar a data na coluna **ATUALIZAÇÃO**.

> Se depois você alterar o código do script, é preciso fazer **Implantar →
> Gerenciar implantações → editar → Nova versão** para a mudança valer na URL.

## Código do Apps Script

```javascript
// Aba do estoque (mesmo gid usado no site)
const GID = 961434769;

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets().find(s => s.getSheetId() === GID);
    if (!sheet) throw new Error("Aba com gid " + GID + " não encontrada");

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const values = sheet.getDataRange().getValues();
      const updated = [], notFound = [];

      (data.changes || []).forEach(ch => {
        const cod = String(ch.cod || "").trim().toUpperCase();
        let found = false;
        for (let i = 0; i < values.length; i++) {
          if (String(values[i][0]).trim().toUpperCase() === cod) {
            sheet.getRange(i + 1, 3).setValue(ch.newTotal); // coluna C = TOTAL UN
            sheet.getRange(i + 1, 8).setValue(new Date());  // coluna H = ATUALIZAÇÃO
            updated.push(ch.cod);
            found = true;
            break;
          }
        }
        if (!found) notFound.push(ch.cod);
      });

      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, updated: updated, notFound: notFound }))
        .setMimeType(ContentService.MimeType.JSON);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## Avisos

- **Se a coluna TOTAL UN tiver fórmula** (ex.: caixas × unidades por caixa), o
  script substitui a fórmula pelo número. Nesse caso me avise, que adapto para
  atualizar as colunas de caixas em vez do total.
- O script assume: coluna **A** = código (SKU), coluna **C** = TOTAL UN,
  coluna **H** = ATUALIZAÇÃO — o mesmo layout que o site já lê.
- "Quem pode acessar: Qualquer pessoa" significa que quem tiver a URL do script
  consegue enviar atualizações. A URL é longa e não é pública, mas trate-a como
  um segredo do time.
