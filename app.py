#coded by Xeot403

import asyncio
import os
import json
import logging
import sqlite3
import bcrypt
from aiohttp import web
import traceback
import aiohttp_cors

ROOT = os.path.join(os.path.dirname(__file__), '..')

# SQLite configuration (local file)
DB_PATH = os.environ.get('CHATX_DB_PATH', os.path.join(ROOT, 'chatx.db'))

# logging setup
logging.basicConfig(level=os.environ.get('CHATX_LOG_LEVEL', 'INFO'))
logger = logging.getLogger('chatx')

def create_tables_if_missing(conn):
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            display_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    cursor.close()


async def async_init_db(app):
    """Initialize local SQLite DB and create tables.

    Runs on startup; SQLite is local so this is immediate.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        create_tables_if_missing(conn)
        conn.close()
        app['db_ready'] = True
        logger.info('SQLite DB initialized and ready at %s', DB_PATH)
    except Exception as e:
        app['db_ready'] = False
        logger.exception('Failed to initialize SQLite DB: %s', e)


async def async_init_db_task(app):
    """Background task version of DB init loop (same behavior)."""
    await async_init_db(app)


async def start_db_init(app):
    """Startup hook: schedule db init loop as a background task so server can bind immediately."""
    # schedule the background task and return immediately
    task = asyncio.create_task(async_init_db_task(app))
    app['db_init_task'] = task

# map WebSocketResponse -> metadata dict {email, name}
WS_CLIENTS = {}

async def index(request):
    fn = os.path.join(ROOT, 'index.html')
    return web.FileResponse(fn)

async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    # register without metadata yet
    WS_CLIENTS[ws] = {'email': None, 'name': None}
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                # try parse JSON to handle join messages vs chat messages
                try:
                    import json
                    data = json.loads(msg.data)
                except Exception:
                    data = None

                if isinstance(data, dict):
                    if data.get('type') == 'join':
                        # store metadata for this ws
                        WS_CLIENTS[ws] = {'email': data.get('email'), 'name': data.get('name')}
                        # don't broadcast join message as chat
                        continue
                    elif data.get('type') == 'search':
                        # When someone searches, send the search query to all clients
                        for c in list(WS_CLIENTS.keys()):
                            try:
                                await c.send_str(msg.data)
                            except Exception:
                                pass
                        continue

                # otherwise broadcast the raw text to all connected clients
                for c in list(WS_CLIENTS.keys()):
                    try:
                        await c.send_str(msg.data)
                    except Exception:
                        pass
            elif msg.type == web.WSMsgType.ERROR:
                print('ws connection closed with exception', ws.exception())
    finally:
        # remove client
        try:
            WS_CLIENTS.pop(ws, None)
        except Exception:
            pass
    return ws


async def register_handler(request):
    try:
        # ensure DB is ready
        if not request.app.get('db_ready', False):
            return web.json_response({'error': 'Database not ready, try again shortly'}, status=503)
        data = await request.json()
        email = data.get('email')
        password = data.get('password')
        display_name = data.get('display_name', '')
        
        if not email or not password:
            return web.json_response({'error': 'Email and password are required'}, status=400)
        
        # Hash password
        salt = bcrypt.gensalt()
        hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
        
        # Store in SQLite database
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        try:
            cursor.execute(
                'INSERT INTO users (email, password, display_name) VALUES (?, ?, ?)',
                (email, hashed.decode('utf-8'), display_name)
            )
            conn.commit()
            return web.json_response({'success': True})
        except sqlite3.IntegrityError:
            return web.json_response({'error': 'Email already registered'}, status=400)
        finally:
            cursor.close()
            conn.close()
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)

async def login_handler(request):
    try:
        # ensure DB is ready
        if not request.app.get('db_ready', False):
            return web.json_response({'error': 'Database not ready, try again shortly'}, status=503)
        data = await request.json()
        email = data.get('email')
        password = data.get('password')
        
        if not email or not password:
            return web.json_response({'error': 'Email and password are required'}, status=400)
        
        # Verify credentials using SQLite
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        try:
            cursor.execute('SELECT * FROM users WHERE email = ?', (email,))
            user = cursor.fetchone()

            if not user or not bcrypt.checkpw(password.encode('utf-8'), user['password'].encode('utf-8')):
                return web.json_response({'error': 'Invalid credentials'}, status=401)

            return web.json_response({
                'success': True,
                'email': user['email'],
                'display_name': user['display_name']
            })
        finally:
            cursor.close()
            conn.close()
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)

async def online_handler(request):
    # return JSON list of online members (email + name), ignoring nulls
    users = []
    search_query = request.query.get('q', '').lower()
    
    for meta in WS_CLIENTS.values():
        if meta and meta.get('email'):
            email = meta.get('email', '').lower()
            if not search_query or search_query in email:
                users.append({'email': meta.get('email'), 'name': meta.get('name')})
    
    return web.json_response(users)


async def health_handler(request):
    """Simple health endpoint reporting DB readiness and number of connected WS clients."""
    return web.json_response({
        'db_ready': request.app.get('db_ready', False),
        'connected_clients': len(WS_CLIENTS)
    })

def create_app():
    # middleware to ensure errors are returned as JSON to the client
    @web.middleware
    async def json_error_middleware(request, handler):
        try:
            resp = await handler(request)
            if resp is None:
                return web.json_response({'error': 'Empty response from handler'}, status=500)

            # If handler returned an aiohttp Response for an error but not JSON, convert it
            if isinstance(resp, web.Response):
                content_type = (resp.content_type or '').lower()
                if resp.status >= 400 and 'application/json' not in content_type:
                    try:
                        text = (await resp.text()) if resp.body is not None else ''
                    except Exception:
                        text = ''
                    return web.json_response({'error': text or 'Handler error'}, status=resp.status)
            return resp
        except web.HTTPException as http_ex:
            body = http_ex.text or http_ex.reason or ''
            return web.json_response({'error': body or http_ex.reason}, status=http_ex.status)
        except Exception as exc:
            tb = traceback.format_exc()
            print('[server error]', tb)
            return web.json_response({'error': 'Internal server error', 'details': str(exc)}, status=500)

    app = web.Application(middlewares=[json_error_middleware])
    # mark DB as not ready until background init completes
    app['db_ready'] = False
    # static files
    static_path = os.path.join(ROOT, 'static')
    app.router.add_static('/static/', static_path, show_index=True)
    app.router.add_get('/', index)
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/online', online_handler)
    app.router.add_get('/health', health_handler)
    app.router.add_post('/register', register_handler)
    app.router.add_post('/login', login_handler)
    # initialize DB on startup (non-blocking to import)
    app.on_startup.append(start_db_init)
    # enable CORS for development servers (e.g., Live Server on port 5500)
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
        )
    })
    # register CORS for each route
    for route in list(app.router.routes()):
        try:
            cors.add(route)
        except Exception:
            # some routes may not be supported by cors.add; ignore those
            pass
    return app

if __name__ == '__main__':
    app = create_app()
    web.run_app(app, host='0.0.0.0', port=8080)
