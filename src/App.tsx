import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
    EmailAuthProvider,
    onAuthStateChanged,
    reauthenticateWithCredential,
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
import { auth, db, firebaseReady } from './firebase'
import './App.css'

type InspectionStatus = 'Conforme' | 'Retrabalho'
type NoticeType = 'sucesso' | 'aviso' | 'info'
type ViewStatusFilter = 'Todos' | InspectionStatus
type ReworkExecutionFilter = 'Todos' | 'Pendentes' | 'Executados'
type ViewPreset = 'today' | 'week' | 'month' | null
type ConfirmAction = 'excluir' | 'limpar'

interface InspectionRecord {
    id: number
    firestoreId?: string
    ownerId?: string
    createdAt?: string
    updatedAt?: string
    createdByEmail?: string
    updatedByEmail?: string
    reworkDone?: boolean
    reworkCompletedAt?: string
    reworkCompletedByEmail?: string
    housekeeper: string
    inspector: string
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
const RECOVERY_NOTIFICATION_EMAIL = 'sarahbomfimm24@gmail.com'

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

const formatDateTimeBR = (value?: string) => {
    if (!value) {
        return 'Não informado'
    }

    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        return value
    }

    return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(parsed)
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

const isReworkPending = (record: InspectionRecord) =>
    record.status === 'Retrabalho' && !record.reworkDone

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

const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
}

function App() {
    const rooms = useMemo(() => buildRooms(), [])
    const initialNow = useMemo(() => getNowValues(), [])

    const [uh, setUh] = useState(rooms[0] ?? '')
    const [housekeeper, setHousekeeper] = useState('')
    const [inspector, setInspector] = useState('')
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
    const [isLoginTransition, setIsLoginTransition] = useState(false)

    const [editModalOpen, setEditModalOpen] = useState(false)
    const [editingRecordId, setEditingRecordId] = useState<number | null>(null)
    const [editUh, setEditUh] = useState(rooms[0] ?? '')
    const [editHousekeeper, setEditHousekeeper] = useState('')
    const [editInspector, setEditInspector] = useState('')
    const [editStatus, setEditStatus] = useState<InspectionStatus>('Conforme')
    const [editReworkDone, setEditReworkDone] = useState(false)
    const [editDate, setEditDate] = useState(initialNow.date)
    const [editTime, setEditTime] = useState(initialNow.time)
    const [editNote, setEditNote] = useState('')
    const [editRecordAudit, setEditRecordAudit] = useState<InspectionRecord | null>(null)

    const [viewStartDate, setViewStartDate] = useState(initialNow.date)
    const [viewEndDate, setViewEndDate] = useState(initialNow.date)
    const [viewStatus, setViewStatus] = useState<ViewStatusFilter>('Todos')
    const [viewReworkExecution, setViewReworkExecution] = useState<ReworkExecutionFilter>('Todos')
    const [viewSearch, setViewSearch] = useState('')
    const [isFilterActive, setIsFilterActive] = useState(false)
    const [activeViewPreset, setActiveViewPreset] = useState<ViewPreset>(null)

    const [notifications, setNotifications] = useState<NotificationItem[]>([])
    const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
        isOpen: false,
        action: 'excluir',
    })
    const [clearRecordsPassword, setClearRecordsPassword] = useState('')
    const [clearRecordsError, setClearRecordsError] = useState('')
    const [isConfirmingClear, setIsConfirmingClear] = useState(false)

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

        if (viewReworkExecution !== 'Todos') {
            if (record.status !== 'Retrabalho') {
                return false
            }

            if (viewReworkExecution === 'Pendentes' && record.reworkDone) {
                return false
            }

            if (viewReworkExecution === 'Executados' && !record.reworkDone) {
                return false
            }
        }

        const searchTerm = viewSearch.trim().toLowerCase()
        if (searchTerm) {
            const uhMatch = record.uh.toLowerCase().includes(searchTerm)
            const noteMatch = record.note.toLowerCase().includes(searchTerm)
            const housekeeperMatch = (record.housekeeper ?? '').toLowerCase().includes(searchTerm)
            const inspectorMatch = (record.inspector ?? '').toLowerCase().includes(searchTerm)
            if (!uhMatch && !noteMatch && !housekeeperMatch && !inspectorMatch) {
                return false
            }
        }

        return true
    })

    const stats = useMemo(() => {
        const total = viewedRecords.length
        const conformes = viewedRecords.filter((r) => r.status === 'Conforme').length
        const retrabalho = total - conformes
        const retrabalhoPendente = viewedRecords.filter((record) => isReworkPending(record)).length
        const retrabalhoExecutado = viewedRecords.filter((record) => record.status === 'Retrabalho' && record.reworkDone).length
        const conformidadePercentual = total > 0 ? Math.round((conformes / total) * 100) : 0
        const retrabalhoPercentual = total > 0 ? Math.round((retrabalho / total) * 100) : 0

        return {
            total,
            conformes,
            retrabalho,
            retrabalhoPendente,
            retrabalhoExecutado,
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
                        createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
                        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
                        createdByEmail: typeof data.createdByEmail === 'string' ? data.createdByEmail : undefined,
                        updatedByEmail: typeof data.updatedByEmail === 'string' ? data.updatedByEmail : undefined,
                        reworkDone: typeof data.reworkDone === 'boolean' ? data.reworkDone : false,
                        reworkCompletedAt: typeof data.reworkCompletedAt === 'string' ? data.reworkCompletedAt : undefined,
                        reworkCompletedByEmail: typeof data.reworkCompletedByEmail === 'string' ? data.reworkCompletedByEmail : undefined,
                        housekeeper: typeof data.housekeeper === 'string' ? data.housekeeper : '',
                        inspector: typeof data.inspector === 'string' ? data.inspector : '',
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

    useEffect(() => {
        if (!isLoggedIn) {
            setIsLoginTransition(false)
            return
        }

        if (!isRecordsLoading) {
            const timer = window.setTimeout(() => {
                setIsLoginTransition(false)
            }, 820)

            return () => window.clearTimeout(timer)
        }
    }, [isLoggedIn, isRecordsLoading])

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
        setIsLoginTransition(true)
        setIsAuthenticating(true)

        try {
            await signInWithEmailAndPassword(auth, normalizedEmail, trimmedPassword)
            setLoginPassword('')
        } catch (error) {
            setAuthError(getFirebaseErrorMessage(error, 'Credenciais inválidas. Verifique seu usuário no Firebase Auth.'))
            setIsLoginTransition(false)
        } finally {
            setIsAuthenticating(false)
        }
    }

    const handleLogout = () => {
        if (!auth) {
            return
        }

        setIsLoginTransition(false)

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
        const normalizedEmail = loginEmail.trim().toLowerCase()
        if (!normalizedEmail) {
            setAuthError('Informe seu e-mail para recuperar a senha.')
            return
        }

        try {
            if (!db) {
                setAuthError('Configuração do Firebase ausente. Não foi possível registrar a solicitação de recuperação.')
                return
            }

            await addDoc(collection(db, 'passwordRecoveryRequests'), {
                email: normalizedEmail,
                destinationEmail: RECOVERY_NOTIFICATION_EMAIL,
                requestedAt: new Date().toISOString(),
                status: 'solicitado',
                origin: 'login',
            })

            if (auth) {
                await sendPasswordResetEmail(auth, normalizedEmail).catch(() => undefined)
            }

            setAuthError('Solicitação de recuperação de senha foi solicitada. Em algum tempo haverá retorno.')
        } catch (error) {
            setAuthError(getFirebaseErrorMessage(error, 'Não foi possível registrar a recuperação de senha para retorno da governança.'))
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

        if (!uh || !housekeeper.trim() || !inspector.trim() || !date || !time) {
            pushNotification('Preencha UH, camareira, inspetor, data e hora para salvar.', 'aviso')
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdByEmail: currentUser.email ?? '',
            updatedByEmail: currentUser.email ?? '',
            reworkDone: false,
            housekeeper: housekeeper.trim(),
            inspector: inspector.trim(),
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
            setHousekeeper('')
            setInspector('')
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
        setEditRecordAudit(record)
        setEditUh(record.uh)
        setEditHousekeeper(record.housekeeper)
        setEditInspector(record.inspector)
        setEditStatus(record.status)
        setEditReworkDone(Boolean(record.reworkDone))
        setEditDate(record.date)
        setEditTime(record.time)
        setEditNote(record.note)
    }

    const closeEditModal = () => {
        setEditModalOpen(false)
        setEditingRecordId(null)
        setEditRecordAudit(null)
        setEditReworkDone(false)
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

        if (!editUh || !editHousekeeper.trim() || !editInspector.trim() || !editDate || !editTime) {
            pushNotification('Preencha UH, camareira, inspetor, data e hora para atualizar.', 'aviso')
            return
        }

        const recordToUpdate = records.find((record) => record.id === editingRecordId)
        if (!recordToUpdate?.firestoreId) {
            pushNotification('Registro não encontrado para atualização.', 'aviso')
            return
        }

        setIsSavingEdit(true)

        try {
            const nowIso = new Date().toISOString()
            const nextReworkDone = editStatus === 'Retrabalho' ? editReworkDone : false
            const nextReworkCompletedAt =
                editStatus === 'Retrabalho' && editReworkDone
                    ? recordToUpdate.reworkDone
                        ? recordToUpdate.reworkCompletedAt ?? nowIso
                        : nowIso
                    : null
            const nextReworkCompletedByEmail =
                editStatus === 'Retrabalho' && editReworkDone
                    ? recordToUpdate.reworkDone
                        ? recordToUpdate.reworkCompletedByEmail ?? currentUser?.email ?? ''
                        : currentUser?.email ?? ''
                    : ''

            await updateDoc(doc(db, 'inspections', recordToUpdate.firestoreId), {
                uh: editUh,
                housekeeper: editHousekeeper.trim(),
                inspector: editInspector.trim(),
                status: editStatus,
                reworkDone: nextReworkDone,
                reworkCompletedAt: nextReworkCompletedAt,
                reworkCompletedByEmail: nextReworkCompletedByEmail,
                date: editDate,
                month: getMonthFromDate(editDate),
                time: editTime,
                note: editNote.trim(),
                updatedAt: new Date().toISOString(),
                updatedByEmail: currentUser?.email ?? '',
            })

            closeEditModal()
            pushNotification('Registro atualizado com sucesso.', 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Não foi possível atualizar no Firebase.'), 'aviso')
        } finally {
            setIsSavingEdit(false)
        }
    }

    const handleMarkReworkDone = async (record: InspectionRecord) => {
        if (!db || !record.firestoreId) {
            pushNotification('Registro de retrabalho sem referência para atualização.', 'aviso')
            return
        }

        try {
            await updateDoc(doc(db, 'inspections', record.firestoreId), {
                reworkDone: true,
                reworkCompletedAt: new Date().toISOString(),
                reworkCompletedByEmail: currentUser?.email ?? '',
                updatedAt: new Date().toISOString(),
                updatedByEmail: currentUser?.email ?? '',
            })

            pushNotification(`UH ${record.uh} marcada como retrabalho executado.`, 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Não foi possível concluir o retrabalho.'), 'aviso')
        }
    }

    const showPendingReworks = () => {
        setViewStartDate('')
        setViewEndDate('')
        setViewStatus('Retrabalho')
        setViewReworkExecution('Pendentes')
        setViewSearch('')
        setIsFilterActive(true)
        setActiveViewPreset(null)
    }

    const showAllReworks = () => {
        setViewStartDate('')
        setViewEndDate('')
        setViewStatus('Retrabalho')
        setViewReworkExecution('Todos')
        setViewSearch('')
        setIsFilterActive(true)
        setActiveViewPreset(null)
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
        setClearRecordsPassword('')
        setClearRecordsError('')
        setIsConfirmingClear(false)
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

            closeConfirmDialog()
            return
        }

        if (confirmDialog.action === 'limpar') {
            if (!auth || !currentUser?.email) {
                setClearRecordsError('Sessão inválida. Faça login novamente para continuar.')
                return
            }

            const trimmedPassword = clearRecordsPassword.trim()
            if (!trimmedPassword) {
                setClearRecordsError('Informe sua senha para confirmar a limpeza.')
                return
            }

            try {
                setIsConfirmingClear(true)
                setClearRecordsError('')

                const credential = EmailAuthProvider.credential(currentUser.email, trimmedPassword)
                await reauthenticateWithCredential(currentUser, credential)

                const batch = writeBatch(firestore)
                records.forEach((record) => {
                    if (record.firestoreId) {
                        batch.delete(doc(firestore, 'inspections', record.firestoreId))
                    }
                })
                await batch.commit()
                pushNotification('Todos os registros foram removidos.', 'info')
            } catch (error) {
                const message = getFirebaseErrorMessage(error, 'Não foi possível validar sua senha para limpar os registros.')
                setClearRecordsError(message)
                setIsConfirmingClear(false)
                return
            }

            closeConfirmDialog()
            return
        }
    }

    const clearViewFilters = () => {
        setViewStartDate(initialNow.date)
        setViewEndDate(initialNow.date)
        setViewStatus('Todos')
        setViewReworkExecution('Todos')
        setViewSearch('')
        setIsFilterActive(false)
        setActiveViewPreset(null)
    }

    const applyViewPreset = (preset: 'today' | 'week' | 'month') => {
        const now = new Date()
        const endDate = now.toISOString().slice(0, 10)

        if (preset === 'today') {
            setViewStartDate(endDate)
            setViewEndDate(endDate)
            setIsFilterActive(true)
            setActiveViewPreset('today')
            return
        }

        if (preset === 'week') {
            const start = new Date(now)
            start.setDate(start.getDate() - 6)
            setViewStartDate(start.toISOString().slice(0, 10))
            setViewEndDate(endDate)
            setIsFilterActive(true)
            setActiveViewPreset('week')
            return
        }

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        setViewStartDate(startOfMonth.toISOString().slice(0, 10))
        setViewEndDate(endDate)
        setIsFilterActive(true)
        setActiveViewPreset('month')
    }

    const exportConformes = viewedRecords.filter((record) => record.status === 'Conforme').length
    const exportRetrabalho = viewedRecords.length - exportConformes
    const exportRetrabalhoPendente = viewedRecords.filter((record) => isReworkPending(record)).length

    const exportRows = viewedRecords.map((item) => ({
        UH: item.uh,
        Camareira: item.housekeeper,
        Inspetor: item.inspector,
        Status: item.status,
        'Execução do retrabalho': item.status !== 'Retrabalho' ? '-' : item.reworkDone ? 'Executado' : 'Pendente',
        Data: formatDateBR(item.date),
        Hora: item.time,
        Observacao: item.note,
    }))

    const handleExportCsv = () => {
        if (!exportRows.length) {
            pushNotification('Não há registros nos filtros atuais para exportar.', 'aviso')
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

    const handleExportExcel = async () => {
        if (!exportRows.length) {
            pushNotification('Não há registros nos filtros atuais para exportar.', 'aviso')
            return
        }

        try {
            const XLSX = await import('xlsx')
            const worksheet = XLSX.utils.json_to_sheet(exportRows)

            worksheet['!cols'] = [
                { wch: 8 },
                { wch: 22 },
                { wch: 22 },
                { wch: 14 },
                { wch: 22 },
                { wch: 14 },
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
        } catch {
            pushNotification('Não foi possível gerar o Excel neste momento.', 'aviso')
        }
    }

    const confirmDialogTitle =
        confirmDialog.action === 'limpar' ? 'Limpar registros' : 'Excluir registro'

    const confirmDialogMessage =
        confirmDialog.action === 'limpar'
            ? 'Deseja realmente apagar todos os registros? Essa ação não pode ser desfeita.'
            : 'Deseja realmente excluir este registro de inspeção?'

    if (isLoginTransition) {
        return (
            <div className="app-shell">
                <div className="login-transition" aria-live="polite">
                    <div className="login-transition-content">
                        <div className="login-transition-rings" aria-hidden="true">
                            <span className="ring ring-one" />
                            <span className="ring ring-two" />
                            <span className="ring ring-three" />
                        </div>
                        <h2>Preparando seu ambiente</h2>
                        <p>Validando credenciais e carregando painel de governança...</p>
                    </div>
                </div>
            </div>
        )
    }

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

                <div className="login-layout zoom-in">
                    <section className="login-showcase">
                        <div className="login-showcase-mark">
                            <span className="login-showcase-badge">InspeGov</span>
                            <span className="login-showcase-dot" aria-hidden="true" />
                        </div>
                        <div className="login-showcase-copy">
                            <p className="kicker login-kicker">Governança operacional</p>
                            <h1>Controle de inspeções com uma experiência mais executiva.</h1>
                            <p className="login-subtitle">
                                Acompanhe conformidade, registre ocorrências e mantenha rastreabilidade com um painel pensado para rotinas de governança.
                            </p>
                        </div>
                        <div className="login-showcase-visual" aria-hidden="true">
                            <img src={`${import.meta.env.BASE_URL}hotel-login-hero.svg`} alt="" />
                        </div>
                        <div className="login-showcase-metrics" aria-hidden="true">
                            <article className="login-metric-card">
                                <strong>Monitoramento</strong>
                                <span>Status e histórico em uma única visão.</span>
                            </article>
                            <article className="login-metric-card">
                                <strong>Rastreabilidade</strong>
                                <span>Registros auditáveis para operação e gestão.</span>
                            </article>
                        </div>
                    </section>

                    <form className="login-card" onSubmit={handleLogin}>
                        <div className="login-card-header">
                            <p className="kicker login-kicker">Acesso seguro</p>
                            <h2>Entrar no sistema</h2>
                            <p className="login-card-subtitle">Use suas credenciais corporativas para acessar o painel de inspeções.</p>
                        </div>

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
                            Redefinir senha
                        </button>
                    </form>
                </div>
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

            <header
                className="topbar"
                role="button"
                tabIndex={0}
                onClick={scrollToTop}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        scrollToTop()
                    }
                }}
            >
                <div>
                    <p className="kicker">InspeGov</p>
                    <h1>Gestão de Governança</h1>
                    <p className="subtitle">Painel de controle e monitoramento de qualidade.</p>
                </div>
                <div className="user-profile" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
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
                        <span className="stat-foot">Baseado nos filtros de visualização ativos</span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-label">Conformidade</span>
                        <strong className="stat-value">{stats.conformidadePercentual}%</strong>
                        <div className="progress-bar-container"><div className="progress-fill" style={{ width: `${stats.conformidadePercentual}%` }}></div></div>
                        <span className="stat-foot">{stats.conformes} inspeções conformes</span>
                    </div>
                    <button type="button" className={`stat-card danger interactive ${isFilterActive && viewStatus === 'Retrabalho' && viewReworkExecution === 'Todos' ? 'active' : ''}`} onClick={showAllReworks}>
                        <span className="stat-label">Retrabalhos totais</span>
                        <strong className="stat-value">{stats.retrabalho}</strong>
                        <span className="stat-foot">{stats.retrabalhoExecutado} executados e {stats.retrabalhoPendente} pendentes</span>
                    </button>
                    <button type="button" className={`stat-card warning interactive ${isFilterActive && viewStatus === 'Retrabalho' && viewReworkExecution === 'Pendentes' ? 'active' : ''}`} onClick={showPendingReworks}>
                        <span className="stat-label">Retrabalho não executado</span>
                        <strong className="stat-value">{stats.retrabalhoPendente}</strong>
                        <span className="stat-foot">Clique para listar apenas os pendentes das camareiras</span>
                    </button>
                </section>

                <section className="panel form-panel">
                    <div className="panel-header">
                        <span className="icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M7 3.75H14.25L18.5 8V20.25H7V3.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M14 3.75V8H18.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M9.5 12H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M9.5 15.5H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                        </span>
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

                        <div className="two-columns">
                            <label>
                                Camareira
                                <input
                                    type="text"
                                    value={housekeeper}
                                    onChange={(event) => setHousekeeper(event.target.value)}
                                    placeholder="Nome da camareira"
                                    required
                                />
                            </label>

                            <label>
                                Inspetor(a)
                                <input
                                    type="text"
                                    value={inspector}
                                    onChange={(event) => setInspector(event.target.value)}
                                    placeholder="Quem inspecionou"
                                    required
                                />
                            </label>
                        </div>

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
                        <span className="icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M4 19.25H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M7.5 16.25V11.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M12 16.25V7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M16.5 16.25V9.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                        </span>
                        <h2>Inspeções do período selecionado</h2>
                        <span className="badge-count">{viewedRecords.length} inspeções</span>
                    </div>

                    <div className="view-filters">
                        <p className="filters-title">Filtros de consulta e exportação</p>
                        <div className="fancy-date-range">
                            <label>
                                Início
                                <input
                                    type="date"
                                    value={viewStartDate}
                                    onChange={(event) => {
                                        setViewStartDate(event.target.value)
                                        setIsFilterActive(true)
                                        setActiveViewPreset(null)
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
                                        setActiveViewPreset(null)
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
                                        setActiveViewPreset(null)
                                    }}
                                >
                                    <option value="Todos">Todos</option>
                                    <option value="Conforme">Conforme</option>
                                    <option value="Retrabalho">Retrabalho</option>
                                </select>
                            </label>
                            <label>
                                Execução
                                <select
                                    value={viewReworkExecution}
                                    onChange={(event) => {
                                        setViewReworkExecution(event.target.value as ReworkExecutionFilter)
                                        setIsFilterActive(true)
                                        setActiveViewPreset(null)
                                    }}
                                >
                                    <option value="Todos">Todos</option>
                                    <option value="Pendentes">Pendentes</option>
                                    <option value="Executados">Executados</option>
                                </select>
                            </label>
                            <label>
                                Buscar
                                <input
                                    type="text"
                                    value={viewSearch}
                                    onChange={(event) => {
                                        setViewSearch(event.target.value)
                                        setIsFilterActive(true)
                                        setActiveViewPreset(null)
                                    }}
                                    placeholder="UH, observação, camareira ou inspetor(a)"
                                />
                            </label>
                        </div>
                        <div className="view-presets">
                            <button
                                type="button"
                                className={activeViewPreset === 'today' ? 'ghost-btn active-filter-preset' : 'ghost-btn'}
                                onClick={() => applyViewPreset('today')}
                            >
                                Hoje
                            </button>
                            <button
                                type="button"
                                className={activeViewPreset === 'week' ? 'ghost-btn active-filter-preset' : 'ghost-btn'}
                                onClick={() => applyViewPreset('week')}
                            >
                                Últimos 7 dias
                            </button>
                            <button
                                type="button"
                                className={activeViewPreset === 'month' ? 'ghost-btn active-filter-preset' : 'ghost-btn'}
                                onClick={() => applyViewPreset('month')}
                            >
                                Mês atual
                            </button>
                        </div>
                        <button type="button" className="ghost-btn" onClick={clearViewFilters}>
                            Limpar filtros
                        </button>
                    </div>

                    <div className="report-actions">
                        <button type="button" onClick={handleExportCsv} disabled={!viewedRecords.length}>
                            Exportar CSV
                        </button>
                        <button type="button" onClick={handleExportExcel} disabled={!viewedRecords.length}>
                            Exportar Excel
                        </button>
                        <button type="button" className="danger" onClick={requestClearRecords} disabled={!records.length}>
                            Limpar registros
                        </button>
                    </div>

                    {isFilterActive ? (
                        <p className="filter-summary">
                            {viewedRecords.length} registros pelos filtros atuais para visualização/exportação. Conforme: {exportConformes} | Retrabalho: {exportRetrabalho} | Pendentes: {exportRetrabalhoPendente}
                        </p>
                    ) : null}

                    <div className="records-list" role="list" aria-label="Lista de inspeções">
                        {isRecordsLoading ? (
                            <p className="empty-state">Carregando inspeções do Firebase...</p>
                        ) : !viewedRecords.length ? (
                            <div className="empty-state">
                                <span className="empty-state-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M4.75 6.25H19.25V18.25H4.75V6.25Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                        <path d="M8 10.25H16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M8 13.75H13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    </svg>
                                </span>
                                <p>Nenhuma inspeção encontrada com os filtros atuais.</p>
                            </div>
                        ) : (
                            viewedRecords.map((record) => (
                                <article
                                    key={record.firestoreId ?? record.id}
                                    className={`record-card ${isReworkPending(record) ? 'rework-pending-card' : ''} ${record.status === 'Retrabalho' && record.reworkDone ? 'rework-done-card' : ''}`}
                                    role="listitem"
                                >
                                    <div className="record-top">
                                        <strong>UH {record.uh}</strong>
                                        <div className="record-top-badges">
                                            <span className={getStatusClassName(record.status)}>{record.status}</span>
                                            {record.status === 'Retrabalho' ? (
                                                <span className={record.reworkDone ? 'rework-state-badge done' : 'rework-state-badge pending'}>
                                                    {record.reworkDone ? 'Executado' : 'Pendente'}
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                    {record.status === 'Retrabalho' ? (
                                        <div className={record.reworkDone ? 'rework-alert done' : 'rework-alert pending'}>
                                            <span className="rework-alert-dot" aria-hidden="true" />
                                            <div>
                                                <strong>{record.reworkDone ? 'Retrabalho concluído' : 'Retrabalho aguardando execução'}</strong>
                                                <span>
                                                    {record.reworkDone
                                                        ? `Finalizado em ${formatDateTimeBR(record.reworkCompletedAt)}${record.reworkCompletedByEmail ? ` por ${record.reworkCompletedByEmail}` : ''}`
                                                        : 'Deixe esta UH em atenção até a camareira concluir a correção.'}
                                                </span>
                                            </div>
                                        </div>
                                    ) : null}
                                    <p>
                                        <b>Camareira:</b> {record.housekeeper || 'Não informado'}
                                    </p>
                                    <p>
                                        <b>Inspetor(a):</b> {record.inspector || 'Não informado'}
                                    </p>
                                    <p>
                                        <b>Data:</b> {formatDateBR(record.date)}
                                    </p>
                                    <p>
                                        <b>Hora:</b> {record.time}
                                    </p>
                                    <p>
                                        <b>Observação:</b> {record.note || 'Sem observação'}
                                    </p>
                                    <div className="card-actions">
                                        {isReworkPending(record) ? (
                                            <button
                                                type="button"
                                                className="card-btn highlight"
                                                onClick={() => handleMarkReworkDone(record)}
                                                disabled={!record.firestoreId}
                                            >
                                                Marcar retrabalho executado
                                            </button>
                                        ) : null}
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

            <footer className="app-footer">
                <p>© {new Date().getFullYear()} Sarah Bomfim</p>
            </footer>

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
                            <div className="audit-meta">
                                <p><b>Criado em:</b> {formatDateTimeBR(editRecordAudit?.createdAt)}</p>
                                <p><b>Criado por:</b> {editRecordAudit?.createdByEmail || 'Não informado'}</p>
                                <p><b>Última atualização:</b> {formatDateTimeBR(editRecordAudit?.updatedAt)}</p>
                                <p><b>Atualizado por:</b> {editRecordAudit?.updatedByEmail || 'Não informado'}</p>
                            </div>

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

                            <div className="two-columns">
                                <label>
                                    Camareira
                                    <input
                                        type="text"
                                        value={editHousekeeper}
                                        onChange={(event) => setEditHousekeeper(event.target.value)}
                                        placeholder="Nome da camareira"
                                        required
                                    />
                                </label>

                                <label>
                                    Inspetor(a)
                                    <input
                                        type="text"
                                        value={editInspector}
                                        onChange={(event) => setEditInspector(event.target.value)}
                                        placeholder="Quem inspecionou"
                                        required
                                    />
                                </label>
                            </div>

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

                            {editStatus === 'Retrabalho' ? (
                                <label className="checkbox-field">
                                    <input
                                        type="checkbox"
                                        checked={editReworkDone}
                                        onChange={(event) => setEditReworkDone(event.target.checked)}
                                    />
                                    <span>Retrabalho realizado</span>
                                </label>
                            ) : null}

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
                        {confirmDialog.action === 'limpar' ? (
                            <div className="confirm-password-block">
                                <label>
                                    Confirme com sua senha
                                    <input
                                        type="password"
                                        value={clearRecordsPassword}
                                        onChange={(event) => {
                                            setClearRecordsPassword(event.target.value)
                                            if (clearRecordsError) {
                                                setClearRecordsError('')
                                            }
                                        }}
                                        placeholder="Digite a mesma senha do login"
                                        autoComplete="current-password"
                                    />
                                </label>
                                {clearRecordsError ? <p className="confirm-error">{clearRecordsError}</p> : null}
                            </div>
                        ) : null}
                        <div className="confirm-actions">
                            <button type="button" className="ghost-btn" onClick={closeConfirmDialog}>
                                Cancelar
                            </button>
                            <button type="button" className="danger-confirm" onClick={handleConfirmDialog} disabled={isConfirmingClear}>
                                {isConfirmingClear ? 'Validando...' : 'Confirmar'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export default App
