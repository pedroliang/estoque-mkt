# Apps Script do Estoque MKT (v2) — ajuste em massa seguro + backups

O site é estático e só **lê** a planilha. Para gravar (Aprovar mudanças, Backups,
% Upseller) ele chama um Apps Script publicado dentro da própria planilha.

O código completo está em **`apps-script.gs`** (neste repositório).

## Atualizar o script (fazer UMA vez)

1. Abra a planilha → **Extensões → Apps Script**.
2. Apague SÓ o bloco do site (doGet, doPost, pctJson_, setPctSite, getPctSite, baixaEstoqueSite e as variáveis GID_SITE_BAIXA e PCT_KEY) e cole o conteúdo de `apps-script.gs` no lugar. Funções de outras abas ficam como estão. Salve (Ctrl+S).
3. **Implantar → Gerenciar implantações → lápis (editar) → Versão: Nova versão → Implantar.**
   (Assim a URL `/exec` continua a mesma e o site não precisa mudar.)
4. Se o Google pedir autorização de novo, aceite
   (*Avançado → Acessar ... (não seguro)* — é o seu próprio script).

Teste: abra `SUA_URL/exec?action=ping` no navegador → deve mostrar `{"ok":true,"version":2}`.

## O que mudou na v2

- **O cálculo é feito no script**, com o valor ATUAL da planilha e dentro de um
  bloqueio (lock). O site manda só "SKU + quantidade + modo"; não usa mais o
  número que estava carregado na tela (que podia estar desatualizado).
- **Cada ajuste tem um número de lote.** Se a resposta do Google falhar, o site
  pergunta ao script se o lote já foi gravado e, se precisar, reenvia o MESMO lote —
  o script **nunca aplica o mesmo lote duas vezes**. Antes, um erro no meio
  (ex.: "acao desconhecida") fazia a pessoa aprovar de novo e alguns SKUs
  levavam baixa em dobro.
- Depois de gravar, o script **confere** os valores na planilha e avisa se algum
  não bateu.
- **Backup automático antes de cada ajuste** (TOTAL UN + ATUALIZAÇÃO de todos os SKUs).

## Abas criadas automaticamente

- **`_BACKUPS_MKT`** (oculta) — um backup por linha. Guarda os últimos 200.
- **`_LOG_AJUSTES_MKT`** — histórico de cada SKU alterado: data/hora, lote, modo,
  antes, quantidade, depois, status. Útil para auditoria.

Não apague nem edite essas abas manualmente.

## Botão "Backups" no site

- **Desfazer ajuste** — volta só os SKUs daquele ajuste ao valor que tinham antes dele.
- **Restaurar tudo** — volta a aba inteira (TOTAL UN e ATUALIZAÇÃO) para aquele momento
  (data/hora). Use o filtro para achar uma data, ex.: `07/10`.
- **Criar backup agora** — ponto de restauração manual (ex.: antes de uma contagem).
- Toda restauração cria antes um backup do estado atual → dá para voltar atrás.
- Logo após aprovar um ajuste aparece também o botão **"Desfazer este ajuste"**.

## (Opcional) Backup diário automático

No Apps Script: ícone de relógio **Acionadores → Adicionar acionador** →
função `backupDiarioMkt` → *Baseado no tempo* → *Contador de dias* → escolha o horário → Salvar.
Assim existe um ponto de restauração por dia mesmo sem ajustes.

## Observações

- Colunas usadas: **A** = código (SKU), **C** = TOTAL UN, **H** = ATUALIZAÇÃO,
  **K1** = % Upseller. C. FECHADA / C. ABERTA continuam sendo fórmulas a partir de C.
- "Quem pode acessar: Qualquer pessoa" significa que quem tiver a URL do script
  consegue enviar atualizações. Trate a URL como segredo do time.
- O Google Sheets também tem **Arquivo → Histórico de versões**, que serve como
  última linha de defesa.
