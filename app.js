import express from 'express'
import session from 'express-session'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { v4 as uuidv4 } from 'uuid'
import moment from 'moment-timezone'
import os from 'os'

dotenv.config()
const app = express()

//? Conexión a MongoDB
mongoose.connect(process.env.MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('MongoDB Atlas connected'))
.catch((error) => console.error(error))

//? Schema
const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, default: uuidv4, unique: true },
    email: { type: String, required: true },
    nickname: { type: String, required: true },
    createdAt: { type: Date, default: () => moment().tz("America/Mexico_City").toDate(), required: true },
    lastAccess: { type: Date, default: () => moment().tz("America/Mexico_City").toDate() },
    clientData: {
        ip: { type: String, required: true },
        macAddress: { type: String, required: true }
    },
    serverData: {
        ip: { type: String, required: true },
        macAddress: { type: String, required: true }
    },
    inactivityTime: {
        hours: { type: Number, required: true, min: 0 },
        minutes: { type: Number, required: true, min: 0, max: 59 },
        seconds: { type: Number, required: true, min: 0, max: 59 }
    },
    status: { type: String, enum: ["Activa", "Inactiva", "Finalizada por el usuario", "Finalizada por error del sistema"], required: true }
})
const Session = mongoose.model('Session', SessionSchema)

app.use(express.json())
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
}))

//? Conectar a la BD
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        })
        console.log('MongoDB Atlas connected')
    } catch (error) {
        console.error('Error connecting to MongoDB:', error)
    }
}

//? Obtener IP Local
const getLocalIp = () => {
    const interfaces = os.networkInterfaces()
    for (const interfaceName in interfaces) {
        for (const iface of interfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address
            }
        }
    }
    return '127.0.0.1'
}
//? Obtener dirección MAC
const getMacAddress = () => {
    const interfaces = os.networkInterfaces()
    for (const interfaceName in interfaces) {
        for (const iface of interfaces[interfaceName]) {
            if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
                return iface.mac
            }
        }
    }
    return '00:00:00:00:00:00'
}

const INACTIVITY_LIMIT = 2*60*1000
//? Middleware para verificar inactividad
const checkSessionTimeout = async (req, res, next) => {
    if (!req.session.sessionId) return next()

    const session = await Session.findOne({ sessionId: req.session.sessionId })
    if (!session) return next()

    const lastAccessed = new Date(session.lastAccess).getTime()
    const now = Date.now()

    if ((now - lastAccessed) > INACTIVITY_LIMIT) {
        await Session.findOneAndUpdate({ sessionId: req.session.sessionId }, { status: 'Inactiva' })
        req.session.destroy()
        return res.status(401).json({ message: 'Sesión cerrada por inactividad.' })
    }
    next()
}



//? Login
app.post('/login', async (req, res) => {
    const { email, nickname } = req.body

    if (!email || !nickname) {
        return res.status(400).json({ message: 'Falta algún campo.' })
    }

    const sessionId = uuidv4()
    const now = new Date()
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress
    const clientMac = getMacAddress()
    const serverIp = getLocalIp()
    const serverMac = getMacAddress()

    try {
        let session = await Session.findOne({ email, status: 'Activa' })
        if (session) {
            return res.status(400).json({
                message: 'Ya hay una sesión activa para este usuario.',
                sessionId
            })
        }

        const newSession = new Session({
            sessionId,
            email,
            nickname,
            lastAccess: now,
            clientData: { ip: clientIp, macAddress: clientMac },
            serverData: { ip: serverIp, macAddress: serverMac },
            inactivityTime: { hours: 0, minutes: 0, seconds: 0 },
            status: 'Activa',
        })
        await newSession.save()

        req.session.sessionId = sessionId
        req.session.email = email
        req.session.nickname = nickname
        req.session.lastAccess = now

        res.status(200).json({ message: 'Inicio de sesión exitoso.', sessionId })
    } catch (err) {
        res.status(500).json({ message: 'Error al guardar la sesión.', error: err })
    }
})



//? Cerrar sesión
app.post('/logout', checkSessionTimeout, async (req, res) => {
    const { sessionId } = req.body
    if (!sessionId) return res.status(400).json({ message: 'Falta sessionId.' })
    
    await Session.findOneAndUpdate({ sessionId }, { status: 'Finalizada por el usuario' })
    req.session.destroy()
    res.status(200).json({ message: 'Sesión cerrada exitosamente.' })
})



//? Actualizar sesión
app.put('/update', checkSessionTimeout, async (req, res) => {
    const { sessionId, email, nickname } = req.body

    if (!sessionId) {
        return res.status(400).json({ message: 'Falta sessionId.' })
    }

    const session = await Session.findOne({ sessionId })

    if (!session) {
        return res.status(404).json({ message: 'Sesión no encontrada.' })
    }

    if (session.status !== 'Activa') {
        return res.status(401).json({ message: 'La sesión no está activa.' })
    }

    const now = new Date()

    const updatedSession = await Session.findOneAndUpdate(
        { sessionId },
        { lastAccess: now, ...(email && { email }), ...(nickname && { nickname }) },
        { new: true }
    )

    res.status(200).json({
        message: 'Sesión actualizada.',
        session: updatedSession
    })
})




//? Estado de la sesión
app.get('/status', checkSessionTimeout, async (req, res) => {
    const { sessionId } = req.query

    const session = await Session.findOne({ sessionId })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })

    const now = moment().tz("America/Mexico_City")
    const createdAt = moment(session.createdAt).tz("America/Mexico_City")
    const lastAccess = moment(session.lastAccess).tz("America/Mexico_City")

    const sessionDuration = moment.duration(now.diff(createdAt))

    res.status(200).json({
        message: session.status,
        session: {
            ...session.toObject(),
            createdAt: createdAt.format("DD/MM/YYYY HH:mm:ss"),
            lastAccess: lastAccess.format("DD/MM/YYYY HH:mm:ss"),
            inactivityTime: {
                hours: sessionDuration.hours(),
                minutes: sessionDuration.minutes(),
                seconds: sessionDuration.seconds()
            }
        }
    })
})



//? Listado de sesiones activas
app.get('/allCurrentSessions', checkSessionTimeout, async (req, res) => {
    const sessions = await Session.find({ status: 'Activa' })

    const formattedSessions = sessions.map(session => {
        const now = moment().tz("America/Mexico_City")
        const createdAt = moment(session.createdAt).tz("America/Mexico_City")
        const lastAccess = moment(session.lastAccess).tz("America/Mexico_City")

        const sessionDuration = moment.duration(now.diff(createdAt))

        return {
            ...session.toObject(),
            createdAt: createdAt.format("DD/MM/YYYY HH:mm:ss"),
            lastAccess: lastAccess.format("DD/MM/YYYY HH:mm:ss"),
            inactivityTime: {
                hours: sessionDuration.hours(),
                minutes: sessionDuration.minutes(),
                seconds: sessionDuration.seconds()
            }
        }
    })
    res.status(200).json(formattedSessions)
})



//? Listado de todas las sesiones
app.get('/allSessions', checkSessionTimeout, async (req, res) => {
    try {
        const sessions = await Session.find({})

        const formattedSessions = sessions.map(session => {
            const now = moment().tz("America/Mexico_City")
            const createdAt = moment(session.createdAt).tz("America/Mexico_City")
            const lastAccess = moment(session.lastAccess).tz("America/Mexico_City")

            const sessionDuration = moment.duration(now.diff(createdAt))

            return {
                ...session.toObject(),
                createdAt: createdAt.format("DD/MM/YYYY HH:mm:ss"),
                lastAccess: lastAccess.format("DD/MM/YYYY HH:mm:ss"),
                inactivityTime: {
                    hours: sessionDuration.hours(),
                    minutes: sessionDuration.minutes(),
                    seconds: sessionDuration.seconds()
                }
            }
        })

        res.status(200).json(formattedSessions)
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener las sesiones.', error })
    }
})




//? Eliminar todas las sesiones
app.delete('/deleteAllSessions', async (req, res) => {
    try {
        await Session.deleteMany({})
        res.status(200).json({ message: 'Todas las sesiones han sido eliminadas correctamente.' })
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar las sesiones.', error })
    }
})




//? Ruta de bienvenida
app.get('/', (req, res) => {
    return res.status(200).json({
        message: "Bienvenid@ al API de Control de Sesiones",
        author: "Diego Miguel Rivera Chavez"
    })
})

const PORT = 3500
app.listen(PORT, () => {
    console.log(`Ejecutando el servidor en el puerto ${PORT}`)
})
