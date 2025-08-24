// =================================================================
// SERVIDOR DE NOTIFICACIONES BRE-B - VERSIÓN FINAL CORREGIDA
// =================================================================

// Importación de librerías necesarias
require('dotenv').config();
const express = require('express');
const path = require('path');
const mqtt = require('mqtt');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const session = require('express-session');

// --- 1. CONFIGURACIÓN INICIAL ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 2. MIDDLEWARES (Configuraciones que se ejecutan en cada solicitud) ---
app.use(express.json()); // Para entender los JSON que envía Passport
app.use(express.urlencoded({ extended: true })); // Para entender los datos de los formularios de login/registro
app.use(session({
    secret: process.env.SESSION_SECRET || 'un-secreto-muy-seguro-para-desarrollo',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// **CORRECCIÓN PRINCIPAL:** Servir archivos estáticos (HTML) desde la carpeta 'public'
// Esto le dice a Express que la carpeta 'public' contiene archivos a los que se puede acceder desde el navegador.
app.use(express.static(path.join(__dirname, 'public')));

// --- 3. CONEXIÓN AL SERVIDOR MQTT ---
let mqttClient;
if (process.env.MQTT_HOST) {
    const mqttOptions = {
      host: process.env.MQTT_HOST,
      port: 8883,
      protocol: 'mqtts',
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      clientId: `breb_server_${Math.random().toString(16).slice(2, 10)}`
    };
    mqttClient = mqtt.connect(mqttOptions);
    mqttClient.on('connect', () => console.log('Conectado exitosamente al broker MQTT de HiveMQ!'));
    mqttClient.on('error', (err) => console.error('Error de conexión MQTT:', err));
} else {
    console.warn('Variables de entorno MQTT no configuradas. El cliente MQTT no se iniciará.');
}

// --- 4. LÓGICA DEL DASHBOARD EN TIEMPO REAL ---
let clients = []; // Almacena los navegadores conectados al dashboard
const sendEventToClients = (userId, data) => {
    clients.forEach(client => {
        if (client.userId === userId) {
            client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    });
};

// Middleware para proteger rutas y asegurarse de que el usuario haya iniciado sesión
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login.html'); // Si no hay sesión, lo mandamos al login
    }
    next();
};

// --- 5. RUTAS DE LA APLICACIÓN ---

// **NUEVA RUTA PRINCIPAL:**
// Esta ruta maneja lo que ve el usuario cuando entra a la URL raíz.
app.get('/', (req, res) => {
    if (req.session.userId) {
        // Si ya inició sesión, lo enviamos al dashboard.
        res.redirect('/dashboard.html');
    } else {
        // Si no, lo enviamos a la página de login.
        res.redirect('/login.html');
    }
});


// Rutas de Autenticación
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send('Email y contraseña son requeridos.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').insert([{ email, password_hash: hashedPassword }]);
    if (error) return res.status(500).send('Error al registrar usuario. Es posible que el email ya exista.');
    res.redirect('/login.html');
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
        return res.status(401).send('Email o contraseña incorrectos. <a href="/login.html">Volver</a>');
    }
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.redirect('/dashboard.html');
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// Webhook para recibir notificaciones de Passport
app.post('/api/v1/notify', async (req, res) => {
    console.log('¡Notificación de Passport recibida!');
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    // Lógica para procesar la notificación (esta parte no cambia)
    // ...
    
    res.status(200).send('Notificación recibida.');
});

// Ruta para obtener el historial de transacciones (para el dashboard)
app.get('/api/transactions', requireLogin, async (req, res) => {
    const { data } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', req.session.userId)
        .order('created_at', { ascending: false });
    res.json(data || []);
});

// Ruta para la conexión en tiempo real del dashboard
app.get('/events', requireLogin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    clients.push({ id: clientId, userId: req.session.userId, res });
    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
});

// --- 6. INICIAR EL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});