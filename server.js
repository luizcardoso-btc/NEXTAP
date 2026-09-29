require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Usado pelo Railway para checar se o servidor está no ar
app.get('/health', (req, res) => res.status(200).send('ok'));

app.use('/api/auth', require('./auth-routes'));
app.use('/api/resellers', require('./resellers-routes'));
app.use('/api/payments', require('./payments-routes'));
app.use('/api/admin', require('./admin-routes'));
app.use('/', require('./public-routes')); // /r/:code — link que fica no QR Code / NFC da placa

app.get('/', (req, res) => res.send('NexTap backend no ar.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexTap backend rodando na porta ${PORT}`));
