from .models import get_role


def user_role(request):
    role = get_role(request.user)
    context = {"user_role": role}
    if request.user.is_authenticated:
        context["unread_notifications"] = request.user.notifications.filter(is_read=False).count()
    if role == "doctor" and request.user.doctor_profile.is_verified:
        from django.utils import timezone

        from appointments.models import Appointment

        context["doctor_pending_count"] = Appointment.objects.filter(
            doctor=request.user, status=Appointment.Status.PENDING, start__gt=timezone.now()
        ).count()
    return context
