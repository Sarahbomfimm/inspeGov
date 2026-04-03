import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut,
    type User,
} from 'firebase/auth'
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    query,
    updateDoc,
    where,
    writeBatch,
} from 'firebase/firestore'
import * as XLSX from 'xlsx'
import { auth, db, firebaseReady } from './firebase'
import './App.css'

type InspectionStatus = 'Conforme' | 'Retrabalho'
type NoticeType = 'sucesso' | 'aviso' | 'info'
type ViewStatusFilter = 'Todos' | InspectionStatus
type ConfirmAction = 'excluir' | 'limpar'

interface InspectionRecord {
    id: number
    firestoreId?: string
    ownerId?: string
    uh: string
    status: InspectionStatus
    date: string
    month: string
    time: string
    note: string
}

interface NotificationItem {
    id: number
    message: string
    type: NoticeType
}

interface ConfirmDialogState {
    isOpen: boolean
    action: ConfirmAction
    recordId?: string
}

const STORAGE_KEY = 'inspegov-inspections-v1'

const ROOM_RANGES: Array<[number, number]> = [
    [100, 115],
    [201, 215],
    [300, 315],
    [401, 415],
    [501, 515],
    [601, 615],
    [700, 715],
    [801, 815],
    [901, 915],
]

const toTwoDigits = (value: number) => value.toString().padStart(2, '0')

const getNowValues = () => {
    const now = new Date()
    const year = now.getFullYear()
    const month = toTwoDigits(now.getMonth() + 1)
    const day = toTwoDigits(now.getDate())
    const hour = toTwoDigits(now.getHours())
    const minutes = toTwoDigits(now.getMinutes())

    return {
        date: `${year}-${month}-${day}`,
        month: `${year}-${month}`,
        time: `${hour}:${minutes}`,
    }
}

const buildRooms = () => {
    const rooms: string[] = []
    ROOM_RANGES.forEach(([start, end]) => {
        for (let room = start; room <= end; room += 1) {
            rooms.push(room.toString())
        }
    })
    return rooms
}

const formatDateBR = (date: string) => {
    const [year, month, day] = date.split('-')
    if (!year || !month || !day) {
        return date
    }
    return `${day}/${month}/${year}`
}

const formatMonthBR = (month: string) => {
    const [year, monthValue] = month.split('-')
    if (!year || !monthValue) {
        return month
    }
    return `${monthValue}/${year}`
}

const getMonthFromDate = (date: string) => {
    const [year, monthValue] = date.split('-')
    if (!year || !monthValue) {
        return ''
    }
    return `${year}-${monthValue}`
}

const getStatusClassName = (status: InspectionStatus) =>
    status === 'Conforme' ? 'status-conforme' : 'status-retrabalho'

const getUserInitials = (email: string) => {
    const [localPart] = email.split('@')
    const raw = (localPart ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase()
    return raw.slice(0, 2) || 'AD'
}

const getUserDisplayName = (email: string) => {
    const [localPart] = email.split('@')
    if (!localPart) {
        return 'Administrador'
    }

    return localPart
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
}

const isInspectionStatus = (value: unknown): value is InspectionStatus =>
    value === 'Conforme' || value === 'Retrabalho'

const getFirebaseErrorMessage = (error: unknown, fallback: string) => {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = String((error as { code?: unknown }).code ?? '')
        if (code) {
            return `${fallback} (${code})`
        }
    }
    return fallback
}

const downloadBlob = (content: BlobPart, fileName: string, type: string) => {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
}

function App() {
    const rooms = useMemo(() => buildRooms(), [])
    const initialNow = useMemo(() => getNowValues(), [])

    const [uh, setUh] = useState(rooms[0] ?? '')
    const [status, setStatus] = useState<InspectionStatus>('Conforme')
    const [date, setDate] = useState(initialNow.date)
    const [time, setTime] = useState(initialNow.time)
    const [note, setNote] = useState('')

    const [isPageLoading, setIsPageLoading] = useState(true)
    const [isAuthLoading, setIsAuthLoading] = useState(true)
    const [isRecordsLoading, setIsRecordsLoading] = useState(false)
    const [isSavingNewRecord, setIsSavingNewRecord] = useState(false)
    const [isSavingEdit, setIsSavingEdit] = useState(false)
    const [isLoggedIn, setIsLoggedIn] = useState(false)
    const [currentUser, setCurrentUser] = useState<User | null>(null)
    const [loggedUserEmail, setLoggedUserEmail] = useState('')
    const [loginEmail, setLoginEmail] = useState('')
    const [loginPassword, setLoginPassword] = useState('')
    const [authError, setAuthError] = useState('')
    const [isAuthenticating, setIsAuthenticating] = useState(false)

    const [editModalOpen, setEditModalOpen] = useState(false)
    const [editingRecordId, setEditingRecordId] = useState<number | null>(null)
    const [editUh, setEditUh] = useState(rooms[0] ?? '')
    const [editStatus, setEditStatus] = useState<InspectionStatus>('Conforme')
    const [editDate, setEditDate] = useState(initialNow.date)
    const [editTime, setEditTime] = useState(initialNow.time)
    const [editNote, setEditNote] = useState('')

    const [viewStartDate, setViewStartDate] = useState(initialNow.date)
    const [viewEndDate, setViewEndDate] = useState(initialNow.date)
    const [viewStatus, setViewStatus] = useState<ViewStatusFilter>('Todos')
    const [isFilterActive, setIsFilterActive] = useState(false)

    const [exportStartDate, setExportStartDate] = useState('')
    const [exportEndDate, setExportEndDate] = useState('')

    const [notifications, setNotifications] = useState<NotificationItem[]>([])
    const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
        isOpen: false,
        action: 'excluir',
    })

    const [records, setRecords] = useState<InspectionRecord[]>(() => {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) {
            return []
        }

        try {
            const parsed = JSON.parse(raw) as InspectionRecord[]
            if (!Array.isArray(parsed)) {
                return []
            }
            return parsed
        } catch {
            return []
        }
    })

    const viewedRecords = !isFilterActive ? [] : records.filter((record) => {
        if (viewStartDate && record.date < viewStartDate) {
            return false
        }

        if (viewEndDate && record.date > viewEndDate) {
            return false
        }

        if (viewStatus !== 'Todos' && record.status !== viewStatus) {
            return false
        }

        return true
    })

    const stats = useMemo(() => {
        const total = viewedRecords.length
        const conformes = viewedRecords.filter((r) => r.status === 'Conforme').length
        const retrabalho = total - conformes
        const conformidadePercentual = total > 0 ? Math.round((conformes / total) * 100) : 0
        const retrabalhoPercentual = total > 0 ? Math.round((retrabalho / total) * 100) : 0

        return {
            total,
            conformidadePercentual,
            retrabalhoPercentual,
        }
    }, [viewedRecords])

    const userDisplayName = useMemo(() => getUserDisplayName(loggedUserEmail), [loggedUserEmail])
    const userInitials = useMemo(() => getUserInitials(loggedUserEmail), [loggedUserEmail])

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setIsPageLoading(false)
        }, 520)

        return () => window.clearTimeout(timer)
    }, [])

    useEffect(() => {
        if (!auth) {
            setIsAuthLoading(false)
            setIsLoggedIn(false)
            return
        }

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setCurrentUser(user)
            setIsLoggedIn(Boolean(user))
            setLoggedUserEmail(user?.email ?? '')
            setIsAuthLoading(false)
        })

        return () => unsubscribe()
    }, [])

    useEffect(() => {
        if (!db) {
            setIsRecordsLoading(false)
            return
        }

        if (!currentUser) {
            if (!isAuthLoading) {
                setRecords([])
            }
            return
        }

        setIsRecordsLoading(true)
        const recordsQuery = query(collection(db, 'inspections'), where('ownerId', '==', currentUser.uid))

        const unsubscribe = onSnapshot(
            recordsQuery,
            (snapshot) => {
                const nextRecords: InspectionRecord[] = []

                snapshot.docs.forEach((snapshotDoc) => {
                    const data = snapshotDoc.data() as Partial<InspectionRecord>

                    if (
                        typeof data.id !== 'number' ||
                        typeof data.uh !== 'string' ||
                        !isInspectionStatus(data.status) ||
                        typeof data.date !== 'string' ||
                        typeof data.time !== 'string'
                    ) {
                        return
                    }

                    nextRecords.push({
                        id: data.id,
                        firestoreId: snapshotDoc.id,
                        ownerId: data.ownerId,
                        uh: data.uh,
                        status: data.status,
                        date: data.date,
                        month: typeof data.month === 'string' ? data.month : getMonthFromDate(data.date),
                        time: data.time,
                        note: typeof data.note === 'string' ? data.note : '',
                    })
                })

                nextRecords.sort((a, b) => b.id - a.id)

                setRecords(nextRecords)
                localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords))
                setIsRecordsLoading(false)
            },
            (error) => {
                pushNotification(getFirebaseErrorMessage(error, 'Falha ao carregar dados do Firebase.'), 'aviso')
                setIsRecordsLoading(false)
            },
        )

        return () => unsubscribe()
    }, [currentUser, isAuthLoading])

    const pushNotification = (message: string, type: NoticeType = 'info') => {
        const id = Date.now() + Math.floor(Math.random() * 1000)
        setNotifications((current) => [...current, { id, message, type }])

        window.setTimeout(() => {
            setNotifications((current) => current.filter((item) => item.id !== id))
        }, 3300)
    }

    const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!auth) {
            setAuthError('Configuração do Firebase ausente. Defina os secrets do GitHub Pages.')
            return
        }

        const normalizedEmail = loginEmail.trim().toLowerCase()
        const trimmedPassword = loginPassword.trim()

        if (!normalizedEmail || !trimmedPassword) {
            setAuthError('Preencha e-mail e senha para entrar.')
            return
        }

        setAuthError('')
        setIsAuthenticating(true)

        try {
            await signInWithEmailAndPassword(auth, normalizedEmail, trimmedPassword)
            setLoginPassword('')
        } catch (error) {
            setAuthError(getFirebaseErrorMessage(error, 'Credenciais inválidas. Verifique seu usuário no Firebase Auth.'))
        } finally {
            setIsAuthenticating(false)
        }
    }

    const handleLogout = () => {
        if (!auth) {
            return
        }

        signOut(auth)
            .then(() => {
                setLoginEmail('')
                setLoginPassword('')
                setAuthError('')
            })
            .catch(() => {
                pushNotification('Não foi possível encerrar a sessão.', 'aviso')
            })
    }

    const handleResetPassword = async () => {
        if (!auth) {
            setAuthError('Configuração do Firebase ausente. Defina os secrets do GitHub Pages.')
            return
        }

        const normalizedEmail = loginEmail.trim().toLowerCase()
        if (!normalizedEmail) {
            setAuthError('Informe seu e-mail para recuperar a senha.')
            return
        }

        try {
            await sendPasswordResetEmail(auth, normalizedEmail)
            setAuthError('')
            pushNotification('E-mail de recuperação enviado com sucesso.', 'sucesso')
        } catch (error) {
            setAuthError(getFirebaseErrorMessage(error, 'Não foi possível enviar a recuperação para este e-mail.'))
        }
    }

    const handleDateChange = (value: string) => {
        setDate(value)
    }

    const handleEditDateChange = (value: string) => {
        setEditDate(value)
    }

    const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!db) {
            pushNotification('Firebase não configurado para este ambiente.', 'aviso')
            return
        }

        if (!uh || !date || !time) {
            pushNotification('Preencha UH, data e hora para salvar.', 'aviso')
            return
        }

        if (!currentUser) {
            pushNotification('Faça login novamente para registrar inspeções.', 'aviso')
            return
        }

        setIsSavingNewRecord(true)

        const newRecord: InspectionRecord = {
            id: Date.now(),
            ownerId: currentUser.uid,
            uh,
            status,
            date,
            month: getMonthFromDate(date),
            time,
            note: note.trim(),
        }

        try {
            await addDoc(collection(db, 'inspections'), newRecord)
            setStatus('Conforme')
            setNote('')
            pushNotification('Inspeção registrada com sucesso.', 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Falha ao salvar no Firebase. Tente novamente.'), 'aviso')
        } finally {
            setIsSavingNewRecord(false)
        }
    }

    const handleEditRecord = (record: InspectionRecord) => {
        setEditModalOpen(true)
        setEditingRecordId(record.id)
        setEditUh(record.uh)
        setEditStatus(record.status)
        setEditDate(record.date)
        setEditTime(record.time)
        setEditNote(record.note)
    }

    const closeEditModal = () => {
        setEditModalOpen(false)
        setEditingRecordId(null)
    }

    const handleEditSave = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!db) {
            pushNotification('Firebase não configurado para este ambiente.', 'aviso')
            return
        }

        if (!editingRecordId) {
            return
        }

        if (!editUh || !editDate || !editTime) {
            pushNotification('Preencha UH, data e hora para atualizar.', 'aviso')
            return
        }

        const recordToUpdate = records.find((record) => record.id === editingRecordId)
        if (!recordToUpdate?.firestoreId) {
            pushNotification('Registro não encontrado para atualização.', 'aviso')
            return
        }

        setIsSavingEdit(true)

        try {
            await updateDoc(doc(db, 'inspections', recordToUpdate.firestoreId), {
                uh: editUh,
                status: editStatus,
                date: editDate,
                month: getMonthFromDate(editDate),
                time: editTime,
                note: editNote.trim(),
            })

            closeEditModal()
            pushNotification('Registro atualizado com sucesso.', 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Não foi possível atualizar no Firebase.'), 'aviso')
        } finally {
            setIsSavingEdit(false)
        }
    }

    const requestDeleteRecord = (recordId?: string) => {
        if (!recordId) {
            pushNotification('Registro sem referência no Firebase.', 'aviso')
            return
        }

        setConfirmDialog({
            isOpen: true,
            action: 'excluir',
            recordId,
        })
    }

    const requestClearRecords = () => {
        if (!records.length) {
            return
        }

        setConfirmDialog({
            isOpen: true,
            action: 'limpar',
        })
    }

    const closeConfirmDialog = () => {
        setConfirmDialog({ isOpen: false, action: 'excluir' })
    }

    const handleConfirmDialog = async () => {
        if (!db) {
            pushNotification('Firebase não configurado para este ambiente.', 'aviso')
            closeConfirmDialog()
            return
        }

        const firestore = db

        if (confirmDialog.action === 'excluir' && confirmDialog.recordId) {
            try {
                await deleteDoc(doc(firestore, 'inspections', confirmDialog.recordId))

                const deletedRecord = records.find((record) => record.firestoreId === confirmDialog.recordId)
                if (deletedRecord && editingRecordId === deletedRecord.id) {
                    closeEditModal()
                }

                pushNotification('Registro excluído.', 'sucesso')
            } catch (error) {
                pushNotification(getFirebaseErrorMessage(error, 'Não foi possível excluir o registro.'), 'aviso')
            }
        }

        if (confirmDialog.action === 'limpar') {
            try {
                const batch = writeBatch(firestore)
                records.forEach((record) => {
                    if (record.firestoreId) {
                        batch.delete(doc(firestore, 'inspections', record.firestoreId))
                    }
                })
                await batch.commit()
                pushNotification('Todos os registros foram removidos.', 'info')
            } catch (error) {
                pushNotification(getFirebaseErrorMessage(error, 'Não foi possível limpar os registros.'), 'aviso')
            }
        }

        closeConfirmDialog()
    }

    const clearViewFilters = () => {
        setViewStartDate(initialNow.date)
        setViewEndDate(initialNow.date)
        setViewStatus('Todos')
        setIsFilterActive(false)
    }

    const applyViewPreset = (preset: 'today' | 'week' | 'month') => {
        const now = new Date()
        const endDate = now.toISOString().slice(0, 10)

        if (preset === 'today') {
            setViewStartDate(endDate)
            setViewEndDate(endDate)
            setIsFilterActive(true)
            return
        }

        if (preset === 'week') {
            const start = new Date(now)
            start.setDate(start.getDate() - 6)
            setViewStartDate(start.toISOString().slice(0, 10))
            setViewEndDate(endDate)
            setIsFilterActive(true)
            return
        }

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        setViewStartDate(startOfMonth.toISOString().slice(0, 10))
        setViewEndDate(endDate)
        setIsFilterActive(true)
    }

    const filteredRecordsForExport = records.filter((record) => {
        if (exportStartDate && record.date < exportStartDate) {
            return false
        }

        if (exportEndDate && record.date > exportEndDate) {
            return false
        }

        return true
    })

    const exportRows = filteredRecordsForExport.map((item) => ({
        UH: item.uh,
        Status: item.status,
        Data: formatDateBR(item.date),
        Mes: formatMonthBR(item.month),
        Hora: item.time,
        Observacao: item.note,
    }))

    const handleExportCsv = () => {
        if (!exportRows.length) {
            pushNotification('Não há registros no período selecionado para exportar.', 'aviso')
            return
        }

        const headers = Object.keys(exportRows[0])
        const escapeCsv = (value: string) => `"${value.replaceAll('"', '""')}"`
        const lines = [
            headers.join(';'),
            ...exportRows.map((row) =>
                headers
                    .map((header) => escapeCsv(String(row[header as keyof typeof row] ?? '')))
                    .join(';'),
            ),
        ]

        const bom = '\uFEFF'
        downloadBlob(bom + lines.join('\n'), 'relatorio-inspecoes.csv', 'text/csv;charset=utf-8;')
        pushNotification('Arquivo CSV exportado com sucesso.', 'sucesso')
    }

    const handleExportExcel = () => {
        if (!exportRows.length) {
            pushNotification('Não há registros no período selecionado para exportar.', 'aviso')
            return
        }

        const worksheet = XLSX.utils.json_to_sheet(exportRows)

        worksheet['!cols'] = [
            { wch: 8 },
            { wch: 14 },
            { wch: 14 },
            { wch: 10 },
            { wch: 8 },
            { wch: 36 },
        ]

        const headerRange = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1')
        for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: col })
            const cell = worksheet[cellRef]
            if (cell) {
                cell.s = {
                    font: { bold: true, color: { rgb: 'FFFFFF' } },
                    fill: { fgColor: { rgb: '1B4F5C' } },
                    alignment: { horizontal: 'center' },
                    border: {
                        bottom: { style: 'thin', color: { rgb: '0D3640' } },
                    },
                }
            }
        }

        for (let row = 1; row <= headerRange.e.r; row++) {
            for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
                const cellRef = XLSX.utils.encode_cell({ r: row, c: col })
                const cell = worksheet[cellRef]
                if (cell) {
                    cell.s = {
                        alignment: { horizontal: 'center' },
                        border: {
                            bottom: { style: 'thin', color: { rgb: 'D0DDD9' } },
                        },
                    }
                }
            }
        }

        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Inspeções')
        XLSX.writeFile(workbook, 'relatorio-inspecoes.xlsx', { bookSST: true })
        pushNotification('Arquivo Excel exportado com sucesso.', 'sucesso')
    }

    const confirmDialogTitle =
        confirmDialog.action === 'limpar' ? 'Limpar registros' : 'Excluir registro'

    const confirmDialogMessage =
        confirmDialog.action === 'limpar'
            ? 'Deseja realmente apagar todos os registros? Essa ação não pode ser desfeita.'
            : 'Deseja realmente excluir este registro de inspeção?'

    if (isPageLoading || isAuthLoading || (isLoggedIn && isRecordsLoading)) {
        return (
            <div className="app-shell">
                <div className="loading-panel" aria-live="polite">
                    <div className="loading-content">
                        <div className="loading-spinner-large" />
                        <h2>InspeGov</h2>
                        <p>{isPageLoading || isAuthLoading ? 'Validando acesso seguro...' : 'Carregando seus registros...'}</p>
                    </div>
                </div>
            </div>
        )
    }

    if (!firebaseReady) {
        return (
            <div className="app-shell">
                <div className="loading-panel" aria-live="polite">
                    <div className="loading-content">
                        <h2>Configuração pendente</h2>
                        <p>Defina as variáveis VITE_FIREBASE_* no ambiente do GitHub Pages.</p>
                    </div>
                </div>
            </div>
        )
    }

    if (!isLoggedIn) {
        return (
            <div className="login-shell">
                <div className="login-glow login-glow-one" />
                <div className="login-glow login-glow-two" />

                <form className="login-card zoom-in" onSubmit={handleLogin}>
                    <p className="kicker login-kicker">InspeGov Access</p>
                    <h1>Bem-vindo ao Painel</h1>
                    <p className="login-subtitle">Entre com seu acesso corporativo para iniciar o controle de inspeções.</p>

                    <label>
                        E-mail corporativo
                        <input
                            type="email"
                            value={loginEmail}
                            onChange={(event) => setLoginEmail(event.target.value)}
                            placeholder="ex.: supervisor@inspegov.com"
                            autoComplete="username"
                            required
                        />
                    </label>

                    <label>
                        Senha
                        <input
                            type="password"
                            value={loginPassword}
                            onChange={(event) => setLoginPassword(event.target.value)}
                            placeholder="Digite sua senha"
                            autoComplete="current-password"
                            required
                        />
                    </label>

                    {authError ? <p className="login-error">{authError}</p> : null}

                    <button type="submit" className="save-btn login-btn" disabled={isAuthenticating}>
                        {isAuthenticating ? (
                            <>
                                <span className="inline-spinner" aria-hidden="true" />
                                Autenticando...
                            </>
                        ) : (
                            'Entrar no sistema'
                        )}
                    </button>

                    <button type="button" className="ghost-btn login-reset-btn" onClick={handleResetPassword}>
                        Esqueci minha senha
                    </button>
                </form>
            </div>
        )
    }

    return (
        <div className="app-shell">
            <div className="notifications" aria-live="polite">
                {notifications.map((notification) => (
                    <article key={notification.id} className={`notice notice-${notification.type}`}>
                        {notification.message}
                    </article>
                ))}
            </div>

            <header className="topbar">
                <div>
                    <p className="kicker">InspeGov</p>
                    <h1>Gestão de Governança</h1>
                    <p className="subtitle">Painel de controle e monitoramento de qualidade.</p>
                </div>
                <div className="user-profile">
                    <div className="avatar">{userInitials}</div>
                    <div className="user-info">
                        <strong>{userDisplayName}</strong>
                        <span>{loggedUserEmail || 'Unidade Central'}</span>
                    </div>
                    <button type="button" className="ghost-btn topbar-logout" onClick={handleLogout}>Sair</button>
                </div>
            </header>

            <main className="content-grid">
                <section className="stats-row">
                    <div className="stat-card">
                        <span className="stat-label">Inspeções Totais</span>
                        <strong className="stat-value">{stats.total}</strong>
                    </div>
                    <div className="stat-card">
                        <span className="stat-label">Conformidade</span>
                        <strong className="stat-value">{stats.conformidadePercentual}%</strong>
                        <div className="progress-bar-container"><div className="progress-fill" style={{ width: `${stats.conformidadePercentual}%` }}></div></div>
                    </div>
                    <div className="stat-card danger">
                        <span className="stat-label">Retrabalho</span>
                        <strong className="stat-value">{stats.retrabalhoPercentual}%</strong>
                    </div>
                </section>

                <section className="panel form-panel">
                    <div className="panel-header">
                        <span className="icon">📝</span>
                        <h2>Registrar Inspeção</h2>
                    </div>
                    <form onSubmit={handleRegister} className="inspection-form">
                        <label>
                            UH
                            <select value={uh} onChange={(event) => setUh(event.target.value)} required>
                                {rooms.map((room) => (
                                    <option key={room} value={room}>
                                        UH {room}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <div className="status-group" role="radiogroup" aria-label="Status da inspeção">
                            <button
                                type="button"
                                className={status === 'Conforme' ? 'status-btn active conforme' : 'status-btn'}
                                onClick={() => setStatus('Conforme')}
                            >
                                Conforme
                            </button>
                            <button
                                type="button"
                                className={status === 'Retrabalho' ? 'status-btn active retrabalho' : 'status-btn'}
                                onClick={() => setStatus('Retrabalho')}
                            >
                                Retrabalho
                            </button>
                        </div>

                        <div className="three-columns">
                            <label>
                                Data
                                <input
                                    type="date"
                                    value={date}
                                    onChange={(event) => handleDateChange(event.target.value)}
                                    required
                                />
                            </label>

                            <label>
                                Hora
                                <input
                                    type="time"
                                    value={time}
                                    onChange={(event) => setTime(event.target.value)}
                                    required
                                />
                            </label>
                        </div>

                        <label>
                            Observação
                            <textarea
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                                placeholder="Descreva detalhes ou irregularidades..."
                                rows={3}
                            />
                        </label>

                        <button type="submit" className={isSavingNewRecord ? 'save-btn is-saving' : 'save-btn'}>
                            {isSavingNewRecord ? 'Salvando...' : 'Salvar inspeção'}
                        </button>
                    </form>
                </section>

                <section className="panel report-panel">
                    <div className="panel-header">
                        <span className="icon">📊</span>
                        <h2>Inspeções do período selecionado</h2>
                        <span className="badge-count">{viewedRecords.length} inspeções</span>
                    </div>

                    <div className="view-filters">
                        <p className="filters-title">Filtros de visualização</p>
                        <div className="fancy-date-range">
                            <label>
                                Início
                                <input
                                    type="date"
                                    value={viewStartDate}
                                    onChange={(event) => {
                                        setViewStartDate(event.target.value)
                                        setIsFilterActive(true)
                                    }}
                                />
                            </label>
                            <label>
                                Fim
                                <input
                                    type="date"
                                    value={viewEndDate}
                                    onChange={(event) => {
                                        setViewEndDate(event.target.value)
                                        setIsFilterActive(true)
                                    }}
                                />
                            </label>
                            <label>
                                Status
                                <select
                                    value={viewStatus}
                                    onChange={(event) => {
                                        setViewStatus(event.target.value as ViewStatusFilter)
                                        setIsFilterActive(true)
                                    }}
                                >
                                    <option value="Todos">Todos</option>
                                    <option value="Conforme">Conforme</option>
                                    <option value="Retrabalho">Retrabalho</option>
                                </select>
                            </label>
                        </div>
                        <div className="view-presets">
                            <button type="button" className="ghost-btn" onClick={() => applyViewPreset('today')}>
                                Hoje
                            </button>
                            <button type="button" className="ghost-btn" onClick={() => applyViewPreset('week')}>
                                Últimos 7 dias
                            </button>
                            <button type="button" className="ghost-btn" onClick={() => applyViewPreset('month')}>
                                Mês atual
                            </button>
                        </div>
                        <button type="button" className="ghost-btn" onClick={clearViewFilters}>
                            Limpar filtros de visualização
                        </button>
                    </div>

                    <div className="report-actions">
                        <div className="view-filters">
                            <p className="filters-title">Período para exportação</p>
                            <div className="fancy-date-range">
                                <label>
                                    De
                                    <input
                                        type="date"
                                        value={exportStartDate}
                                        onChange={(event) => setExportStartDate(event.target.value)}
                                    />
                                </label>
                                <label>
                                    Até
                                    <input
                                        type="date"
                                        value={exportEndDate}
                                        onChange={(event) => setExportEndDate(event.target.value)}
                                    />
                                </label>
                            </div>
                        </div>

                        <button type="button" onClick={handleExportCsv} disabled={!records.length}>
                            Exportar CSV
                        </button>
                        <button type="button" onClick={handleExportExcel} disabled={!records.length}>
                            Exportar Excel
                        </button>
                        <button type="button" className="danger" onClick={requestClearRecords} disabled={!records.length}>
                            Limpar registros
                        </button>
                    </div>

                    <p className="filter-summary">
                        {filteredRecordsForExport.length} registros no período selecionado para exportação.
                    </p>

                    <div className="records-list" role="list" aria-label="Lista de inspeções">
                        {isRecordsLoading ? (
                            <p className="empty-state">Carregando inspeções do Firebase...</p>
                        ) : !viewedRecords.length ? (
                            <p className="empty-state">Nenhuma inspeção encontrada com os filtros atuais.</p>
                        ) : (
                            viewedRecords.map((record) => (
                                <article key={record.firestoreId ?? record.id} className="record-card" role="listitem">
                                    <div className="record-top">
                                        <strong>UH {record.uh}</strong>
                                        <span className={getStatusClassName(record.status)}>{record.status}</span>
                                    </div>
                                    <p>
                                        <b>Data:</b> {formatDateBR(record.date)}
                                    </p>
                                    <p>
                                        <b>Mês:</b> {formatMonthBR(record.month)}
                                    </p>
                                    <p>
                                        <b>Hora:</b> {record.time}
                                    </p>
                                    <p>
                                        <b>Observação:</b> {record.note || 'Sem observação'}
                                    </p>
                                    <div className="card-actions">
                                        <button type="button" className="card-btn" onClick={() => handleEditRecord(record)}>
                                            Editar
                                        </button>
                                        <button
                                            type="button"
                                            className="card-btn danger"
                                            onClick={() => requestDeleteRecord(record.firestoreId)}
                                            disabled={!record.firestoreId}
                                        >
                                            Excluir
                                        </button>
                                    </div>
                                </article>
                            ))
                        )}
                    </div>
                </section>
            </main>

            {editModalOpen ? (
                <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Editar inspeção">
                    <div className="modal-card zoom-in">
                        <div className="modal-header">
                            <h3>Editar inspeção</h3>
                            <button type="button" className="close-modal" onClick={closeEditModal}>
                                Fechar
                            </button>
                        </div>

                        <form onSubmit={handleEditSave} className="inspection-form">
                            <label>
                                UH
                                <select value={editUh} onChange={(event) => setEditUh(event.target.value)} required>
                                    {rooms.map((room) => (
                                        <option key={room} value={room}>
                                            UH {room}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <div className="status-group" role="radiogroup" aria-label="Status da inspeção">
                                <button
                                    type="button"
                                    className={
                                        editStatus === 'Conforme' ? 'status-btn active conforme' : 'status-btn conforme'
                                    }
                                    onClick={() => setEditStatus('Conforme')}
                                >
                                    Conforme
                                </button>
                                <button
                                    type="button"
                                    className={
                                        editStatus === 'Retrabalho' ? 'status-btn active retrabalho' : 'status-btn retrabalho'
                                    }
                                    onClick={() => setEditStatus('Retrabalho')}
                                >
                                    Retrabalho
                                </button>
                            </div>

                            <div className="three-columns">
                                <label>
                                    Data
                                    <input
                                        type="date"
                                        value={editDate}
                                        onChange={(event) => handleEditDateChange(event.target.value)}
                                        required
                                    />
                                </label>

                                <label>
                                    Hora
                                    <input
                                        type="time"
                                        value={editTime}
                                        onChange={(event) => setEditTime(event.target.value)}
                                        required
                                    />
                                </label>
                            </div>

                            <label>
                                Observação
                                <textarea
                                    value={editNote}
                                    onChange={(event) => setEditNote(event.target.value)}
                                    placeholder="Ex.: Poeira no rodapé"
                                    rows={3}
                                />
                            </label>

                            <button type="submit" className={isSavingEdit ? 'save-btn is-saving' : 'save-btn'}>
                                {isSavingEdit ? 'Atualizando...' : 'Salvar alterações'}
                            </button>
                        </form>
                    </div>
                </div>
            ) : null}

            {confirmDialog.isOpen ? (
                <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={confirmDialogTitle}>
                    <div className="confirm-card zoom-in-soft">
                        <h3>{confirmDialogTitle}</h3>
                        <p>{confirmDialogMessage}</p>
                        <div className="confirm-actions">
                            <button type="button" className="ghost-btn" onClick={closeConfirmDialog}>
                                Cancelar
                            </button>
                            <button type="button" className="danger-confirm" onClick={handleConfirmDialog}>
                                Confirmar
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export default App
