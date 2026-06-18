# Ouvir Junto

Site pra ouvir/ver vídeos do YouTube em sincronia com seus amigos: quem entrar na mesma sala vê o vídeo no mesmo segundo que você, em tempo real.

## Como funciona

- Você cria uma sala e recebe um código de 6 caracteres (e um link pra compartilhar).
- Quem abrir esse link entra direto na sala.
- Qualquer pessoa na sala pode colar um link do YouTube — ele toca pra todo mundo.
- Play, pause e os "saltos" no vídeo são sincronizados via WebSocket. A cada ~4s o player ativo manda um "heartbeat" com a posição atual, e quem estiver com mais de 1.5s de diferença é realinhado automaticamente.

Não tem cadastro, banco de dados ou persistência: o estado da sala vive na memória do servidor. Se o servidor reiniciar, as salas são perdidas (mas é instantâneo recriar uma).

## Rodando localmente

**Com Docker (recomendado, já que você já usa):**

```bash
docker compose up --build
```

Acesse http://localhost:8000

**Sem Docker:**

```bash
cd app
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Estrutura do projeto

```
ouvir-junto/
├── Dockerfile
├── docker-compose.yml
└── app/
    ├── main.py            # FastAPI + WebSocket (lógica de sincronização)
    ├── requirements.txt
    └── static/
        ├── index.html     # tela de criar/entrar na sala + tela do player
        ├── style.css
        └── app.js         # WebSocket client + integração com YouTube IFrame API
```

## Colocando no ar pra usar com os amigos

Pra outras pessoas entrarem, o servidor precisa estar acessível na internet (não só no seu `localhost`). Algumas opções simples, já que o app é só um container Docker:

- **Railway, Render ou Fly.io**: todos têm plano free/baixo custo e fazem deploy direto a partir do `Dockerfile` — só conectar o repositório Git.
- **Uma VPS própria** (ex: Oracle Cloud free tier, ou qualquer VPS barata): sobe com `docker compose up -d` e usa um proxy reverso (Caddy ou Nginx) na frente pra ter HTTPS — necessário pra WebSocket seguro (`wss://`) funcionar bem em produção.

Se for usar HTTPS na frente, não precisa mudar nada no código: o `app.js` já detecta `https:` e troca automaticamente para `wss://`.

## Limitações conhecidas (e ideias pra evoluir)

- **Sem reconexão automática**: se a internet cair, é preciso recarregar a página pra voltar à sala.
- **Qualquer pessoa na sala pode trocar o vídeo ou pausar** — não tem conceito de "host". Pra uso entre amigos isso geralmente é o comportamento desejado, mas dá pra restringir depois (ex: só quem criou a sala pode trocar o vídeo).
- **Sem fila de músicas**: troca o vídeo direto, sem playlist. Seria a próxima evolução natural — manter uma lista em `Room` e adicionar botões de "próxima"/"anterior".
- **Sem chat**: dá pra adicionar fácil reaproveitando o mesmo WebSocket (um novo tipo de mensagem `"chat"`).
- Funciona com qualquer vídeo público do YouTube. Vídeos com bloqueio de incorporação (embedding desabilitado pelo dono) não tocam — é uma restrição do próprio YouTube, não do app.
