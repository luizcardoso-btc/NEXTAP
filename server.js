require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/resellers', require('./routes/resellers'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/', require('./routes/public')); // /r/:code — link que fica no QR Code / NFC da placa

app.get('/', (req, res) => res.send('NexTap backend no ar.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexTap backend rodando na porta ${PORT}`));
