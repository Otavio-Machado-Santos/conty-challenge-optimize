# Descoberta de criadores com consultas em lote

O problema era o N+1: depois de ler campanha e criadores, a função consultava contas, cada métrica e as entregas separadamente para cada criador compatível. Para 2.000 criadores, a página de 20 exigia 3.943 chamadas aos wrappers do banco. A resposta paginada era pequena, mas essas consultas e a leitura de `raw_payload` eram feitas antes da paginação.

## Consultas e índices

1. Buscar somente `niches_json` da campanha pela chave primária; campanha ausente encerra com uma consulta e o mesmo 404.
2. Buscar `id`, `name` e `niches_json` dos criadores. Calcular o score em TypeScript com a mesma regra de interseção da implementação original, inclusive a multiplicidade dos nichos. Campanha sem criadores compatíveis encerra com duas consultas.
3. Ler o alcance mais recente das contas dos criadores compatíveis em uma consulta. O subselect usa o índice `metrics_latest_by_account (account_id, captured_at DESC, id DESC, views)`: cada conta faz uma busca indexada que para na primeira métrica. `views` no índice evita ler o payload da métrica. Conta sem métrica contribui zero; criador sem conta mantém zero. O índice `social_accounts_by_creator (creator_id)` seleciona as contas compatíveis.
4. Contar entregas em lote, por criador e com `delivered_at >= deliveriesSince()`. O índice `deliveries_by_creator_date (creator_id, delivered_at)` permite buscar o intervalo de cada criador sem ler todo o histórico.

Os IDs compatíveis são passados como um único JSON e convertidos em linhas por `json_each(?)`. Isso mantém um único parâmetro, mesmo quando há milhares de IDs; não há uma lista de placeholders que atinja o limite de variáveis do SQLite. A restrição também evita consultar métricas de criadores fora dos nichos.

Os alcances são somados em TypeScript, na ordem de inserção das contas (`rowid`), como na implementação original. O comparador existente foi mantido: score decrescente, alcance decrescente e ID crescente pela comparação JavaScript. Assim, nem a collation SQL nem uma soma SQL introduzem semântica nova. `total` é calculado antes de aplicar o mesmo `slice` da versão original.

Todas as leituras do endpoint continuam passando por `all` e `get` de `src/db.ts`. Os índices são criados uma vez em `openDatabase`, com `IF NOT EXISTS`, incluindo bancos previamente criados. `src/app.ts`, o fixture, o bench e os oito testes originais não foram alterados. Nenhuma resposta é armazenada em cache.

O [`EXPLAIN QUERY PLAN` registrado](evidence/query-plan.json) confirma busca pelo índice de criador para contas, busca pelo índice de cobertura para a métrica e busca pelo índice de cobertura com intervalo de data para as entregas. A ordenação das contas por `rowid` usa uma árvore temporária; é uma decisão explícita para preservar a ordem da soma, sem alegar que todo o processamento é constante.

## Evidência

Base medida: `b319e268ee6cb1ed2cf3b28793f04aa5c419c34d`. Runtime: Node 22.23.3. Bench fornecido sem alteração, SQLite em memória, seed 7 e 2.000 criadores, uma chamada de aquecimento e cinco amostras.

| Comando e resultado | Evidência |
| --- | --- |
| `npm test` antes: 6 passam, 2 falham; 170 consultas no seed e 1.203 em 600 criadores | [before-test.txt](evidence/before-test.txt) |
| `npm run bench` antes: queries 3943, p50_ms 1404.6, p95_ms 3549.0 | [before-bench.txt](evidence/before-bench.txt) |
| `npm test` depois: 14 testes passam | [after-test.txt](evidence/after-test.txt) |
| `npm run typecheck`: passa | [after-typecheck.txt](evidence/after-typecheck.txt) |
| `npm run bench` depois: queries 4, p50_ms 6.6, p95_ms 7.8 | [after-bench.txt](evidence/after-bench.txt) |
| HTTP real: health, página com 20 resultados, página além do fim e campanha ausente | [manifesto HTTP](evidence/http-validation.json) |

Os testes diferenciais usam uma referência congelada da função original, identificada pelo commit acima. A referência mudou somente os caminhos de importação e omitiu comentários destinados a ferramentas, que não são contrato. Em dois seeds diferentes com 4.000 criadores, comparam a resposta inteira e diversas páginas, incluindo a última incompleta e offsets além do fim. Cada requisição otimizada usa exatamente quatro chamadas aos wrappers.

As regressões também verificam métrica empatada com desempate por ID, múltiplas contas e contas sem métrica, limite inclusivo dos 90 dias, nichos repetidos, ordenação de IDs Unicode pela regra original, normalização HTTP, ausência de campanha e ausência de compatíveis. Um teste modifica métrica, entrega e nome após a primeira leitura para verificar que a próxima página reflete o banco.

## Limites e decisões

O número de consultas é constante, mas o trabalho de processar e ordenar candidatos continua crescendo com o volume de criadores compatíveis. Há materialização dos candidatos e ordenação em memória; uma tabela de nichos normalizada e paginação inteiramente SQL seriam outras opções de evolução, com atenção à equivalência do comparador. O objetivo aqui é resolver o orçamento sem trocar o contrato nem a tecnologia fornecida.

Os índices aumentam o armazenamento e o custo de escrita do seed. O SQLite continua síncrono, como na base. O benchmark pequeno em memória mede esta solução local; estabilidade de latência em carga concorrente e volumes de produção exigiria outra medição. Não há promessa de tempo constante ou extrapolação dos percentis para produção.

`npm audit --omit=dev` não encontrou vulnerabilidades nas dependências de produção nesta validação ([log](evidence/production-audit.json)). O audit completo reportou três vulnerabilidades herdadas no Vitest 3 e suas dependências de desenvolvimento ([log](evidence/dependency-audit.json)); o npm recomenda um upgrade major do framework. Nenhuma dependência foi alterada neste ajuste de desempenho, e o servidor não importa o framework de testes.

## Uso de IA e revisão

Codex implementou o código, escreveu as regressões e a documentação, e executou testes, typecheck, benchmark, auditoria e chamadas HTTP. A evidência contém saídas reais desses comandos. A referência original é uma fonte de comparação; o fato de um teste passar não substitui a revisão independente nem prova um deploy de produção.

O coordenador registrará a revisão por agentes independentes antes de publicar e enviar a entrega. Não há revisão humana ou revisão independente já concluída declarada neste documento.
