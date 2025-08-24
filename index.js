// Importamos las librerías necesarias.
require('dotenv').config(); // Para manejar variables de entorno (credenciales secretas)
const express = require('express'); // Para crear el servidor web
const mqtt = require('mqtt'); // Para comunicarnos con los dispositivos de voz
const path = require('path'); // Para manejar rutas de archivos
const { createClient } = require('@supabase/supabase-js'); // Para la base de datos
const bcrypt = require('bcryptjs'); // Para encriptar contraseñas
const session = require('express-session'); // Para manejar sesiones de usuario

// --- CONFIGURACIÓN ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || 'un-secreto-muy-seguro-para-desarrollo';
const PASSPORT_WEBHOOK_SECRET = process.env.PASSPORT_WEBHOOK_SECRET;

const app = express();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// --- CONEXIÓN AL SERVIDOR MQTT ---
let mqttClient;
if (MQTT_HOST) {
    const mqttOptions = {
      host: MQTT_HOST,
      port: 8883,
      protocol: 'mqtts',
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
      clientId: `breb_server_${Math.random().toString(16).slice(2, 10)}`
    };
    mqttClient = mqtt.connect(mqttOptions);
    mqttClient.on('connect', () => console.log('Conectado exitosamente al broker MQTT de HiveMQ!'));
    mqttClient.on('error', (err) => console.error('Error de conexión MQTT:', err));
} else {
    console.warn('Variables de entorno MQTT no configuradas. El cliente MQTT no se iniciará.');
}

// --- LÓGICA PARA EL DASHBOARD EN TIEMPO REAL (Server-Sent Events) ---
let clients = [];
const sendEventToClients = (userId, data) => {
    clients.forEach(client => {
        if (client.userId === userId) {
            client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    });
};

// Middleware para proteger rutas
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/');
    }
    next();
};

// --- RUTAS DE AUTENTICACIÓN ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send('Email y contraseña son requeridos.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').insert([{ email, password_hash: hashedPassword }]);
    if (error) return res.status(500).send('Error al registrar usuario. Es posible que el email ya exista.');
    res.redirect('/');
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
        return res.status(401).send('Email o contraseña incorrectos. <a href="/">Volver</a>');
    }
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.redirect('/dashboard');
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).send('No se pudo cerrar sesión.');
        res.redirect('/');
    });
});

// --- ENDPOINT PARA RECIBIR NOTIFICACIONES (WEBHOOK) ---
app.post('/api/v1/notify', async (req, res) => {
    console.log('¡Notificación de Passport recibida!');
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    const eventType = req.body.event_type;
    if (eventType === 'transaction.completed') {
        const transactionData = req.body.data;
        const deviceSerialNumber = transactionData.metadata?.terminal_id || 'dispositivo_desconocido';
        const amount = transactionData.amount;
        const transactionId = transactionData.id || new Date().getTime().toString();

        const { data: deviceOwner, error: ownerError } = await supabase
            .from('devices')
            .select('user_id')
            .eq('serial_number', deviceSerialNumber)
            .single();

        if (ownerError || !deviceOwner) {
            console.error(`Error: No se encontró un dueño para el dispositivo ${deviceSerialNumber}`);
            return res.status(404).send('Dispositivo no registrado.');
        }

        const userId = deviceOwner.user_id;

        const { error: trxError } = await supabase.from('transactions').insert([{
            user_id: userId,
            device_serial_number: deviceSerialNumber,
            amount: amount,
            request_id: transactionId,
            status: 'Completada'
        }]);
        if(trxError) console.error("Error guardando transacción:", trxError.message);

        const dashboardData = {
            id: transactionId,
            device: deviceSerialNumber,
            amount: amount,
            status: 'Completada',
            timestamp: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })
        };
        sendEventToClients(userId, dashboardData);

        if (mqttClient && mqttClient.connected) {
            const topic = `/HMZN/${deviceSerialNumber}`;
            const message = JSON.stringify({ request_id: transactionId, money: String(amount) });
            mqttClient.publish(topic, message, { qos: 1 }, (err) => {
                if (err) console.error('Error al publicar en MQTT:', err);
                else console.log(`Mensaje enviado al dispositivo ${deviceSerialNumber}`);
            });
        }
    }
    res.status(200).send('Notificación recibida.');
});

// --- RUTAS DE LAS PÁGINAS ---
app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    // **CORRECCIÓN:** Añadimos la cabecera Content-Type para que el navegador sepa que es una página web.
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/dashboard', requireLogin, (req, res) => {
    // **CORRECCIÓN:** Añadimos la cabecera Content-Type.
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/transactions', requireLogin, async (req, res) => {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', req.session.userId)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Error al obtener transacciones' });
    res.json(data);
});

app.get('/events', requireLogin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    clients.push({ id: clientId, userId: req.session.userId, res });
    console.log(`Nuevo cliente [${clientId}] del usuario [${req.session.userEmail}] conectado al dashboard.`);

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
        console.log(`Cliente [${clientId}] desconectado.`);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});

/*
 ** NUEVA ESTRUCTURA DE TABLAS EN SUPABASE **
 
 CREATE TABLE users (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   email TEXT UNIQUE NOT NULL,
   password_hash TEXT NOT NULL,
   created_at TIMESTAMPTZ DEFAULT now()
 );
 
 CREATE TABLE devices (
    id BIGSERIAL PRIMARY KEY,
    serial_number TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) NOT NULL,
    status TEXT DEFAULT 'offline',
    created_at TIMESTAMPTZ DEFAULT now()
 );

 CREATE TABLE transactions (
   id BIGSERIAL PRIMARY KEY,
   user_id UUID REFERENCES users(id),
   device_serial_number TEXT,
   amount NUMERIC,
   request_id TEXT UNIQUE,
   status TEXT,
   created_at TIMESTAMPTZ DEFAULT now()
 );
*/
